package com.yepanywhere.mobile.connection

import java.io.Closeable
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONArray
import org.json.JSONObject

class YaResumeCredential(
    val username: String,
    val sessionId: String,
    baseKey: ByteArray,
    val resumeProtocolVersion: Int,
) {
    private val baseKeyBytes = baseKey.copyOf()

    val keySize: Int
        get() = baseKeyBytes.size

    init {
        require(username.isNotBlank())
        require(sessionId.isNotBlank())
        require(baseKeyBytes.size == YaSecureTransportCrypto.KEY_BYTES)
        require(resumeProtocolVersion >= YaSecureTransportCrypto.RESUME_PROTOCOL_VERSION)
    }

    internal fun copyBaseKey(): ByteArray = baseKeyBytes.copyOf()

    override fun equals(other: Any?): Boolean {
        return other is YaResumeCredential &&
            username == other.username &&
            sessionId == other.sessionId &&
            baseKeyBytes.contentEquals(other.baseKeyBytes) &&
            resumeProtocolVersion == other.resumeProtocolVersion
    }

    override fun hashCode(): Int {
        var result = username.hashCode()
        result = 31 * result + sessionId.hashCode()
        result = 31 * result + baseKeyBytes.contentHashCode()
        result = 31 * result + resumeProtocolVersion
        return result
    }
}

data class YaSecureProbeResult(
    val credential: YaResumeCredential,
    val resumed: Boolean,
)

class YaResumeRejectedException(val reason: String) :
    IllegalStateException("Native resume credential rejected: $reason")

class YaNativeSecureSession internal constructor(
    private val listener: SecureSessionListener,
    override val credential: YaResumeCredential,
    override val resumed: Boolean,
) : YaMessageTransport, Closeable {
    override fun send(message: JSONObject) {
        listener.sendEncrypted(message)
    }

    override suspend fun receive(): JSONObject = listener.receive()

    override suspend fun awaitClosed() {
        listener.awaitClosed()
    }

    override suspend fun closeAndAwait() {
        listener.requestClose()
        val closedInTime = withTimeoutOrNull(CLOSE_TIMEOUT_MS) {
            runCatching { listener.awaitClosed() }
            true
        } == true
        if (!closedInTime) {
            listener.abort()
        }
    }

    override fun close() {
        listener.requestClose()
    }

    override fun cancel() {
        listener.abort()
    }

    companion object {
        private const val CLOSE_TIMEOUT_MS = 2_000L
    }
}

/**
 * Opens one authenticated YA secure WebSocket. Connection lifetime, request
 * correlation, subscriptions, route fallback, and retries belong to the
 * higher-level leased connection manager.
 */
class YaNativeSecureConnection(
    private val httpClient: OkHttpClient,
    private val secretBoxFactory: () -> YaSecretBox = ::LazySodiumSecretBox,
) : YaSecureSessionOpener {
    override suspend fun login(
        wsUrl: String,
        username: String,
        password: String,
        relayTarget: String?,
    ): YaNativeSecureSession {
        require(username.isNotBlank())
        require(password.isNotEmpty())
        return open(
            wsUrl = wsUrl,
            relayTarget = relayTarget,
            authentication = FullLoginAuthentication(username, password),
        )
    }

    override suspend fun resume(
        wsUrl: String,
        credential: YaResumeCredential,
        relayTarget: String?,
    ): YaNativeSecureSession {
        return open(
            wsUrl = wsUrl,
            relayTarget = relayTarget,
            authentication = ResumeAuthentication(credential),
        )
    }

    suspend fun loginAndProbe(
        wsUrl: String,
        username: String,
        password: String,
    ): YaSecureProbeResult {
        return probe(login(wsUrl, username, password))
    }

    suspend fun resumeAndProbe(
        wsUrl: String,
        credential: YaResumeCredential,
    ): YaSecureProbeResult {
        return probe(resume(wsUrl, credential))
    }

    private suspend fun open(
        wsUrl: String,
        relayTarget: String?,
        authentication: Authentication,
    ): YaNativeSecureSession {
        val request = Request.Builder().url(wsUrl).build()
        val listener = SecureSessionListener(
            authentication = authentication,
            relayTarget = relayTarget,
            secretBox = secretBoxFactory(),
        )
        val socket = httpClient.newWebSocket(request, listener)
        listener.attach(socket)
        return try {
            listener.awaitAuthenticated()
        } catch (error: Throwable) {
            listener.abort()
            throw error
        }
    }

    private suspend fun probe(session: YaNativeSecureSession): YaSecureProbeResult {
        try {
            val pongId = "android-native-${UUID.randomUUID()}"
            session.send(JSONObject().put("type", "ping").put("id", pongId))
            val response = session.receive()
            check(
                response.getString("type") == "pong" &&
                    response.getString("id") == pongId,
            ) { "Native secure probe received an unexpected message" }
            return YaSecureProbeResult(session.credential, session.resumed)
        } finally {
            session.closeAndAwait()
        }
    }
}

internal class SecureSessionListener(
    private val authentication: Authentication,
    private val relayTarget: String?,
    private val secretBox: YaSecretBox,
) : WebSocketListener() {
    private val authenticated = CompletableDeferred<YaNativeSecureSession>()
    private val closed = CompletableDeferred<Unit>()
    private val incoming = Channel<JSONObject>(INCOMING_BUFFER_SIZE)
    private val terminated = AtomicBoolean(false)
    private val sendLock = Any()
    private var socket: WebSocket? = null
    private var transportKey: ByteArray? = null
    private var nextOutboundSequence = 0L
    private var lastInboundSequence = -1L
    private var relayPaired = relayTarget == null
    private var closeRequested = false

    fun attach(webSocket: WebSocket) {
        socket = webSocket
    }

    suspend fun awaitAuthenticated(): YaNativeSecureSession = authenticated.await()

    suspend fun receive(): JSONObject = incoming.receive()

    suspend fun awaitClosed() {
        closed.await()
    }

    override fun onOpen(webSocket: WebSocket, response: Response) {
        if (terminated.get()) {
            webSocket.cancel()
            return
        }
        socket = webSocket
        runCatching {
            val target = relayTarget
            if (target == null) {
                authentication.start(this)
            } else {
                sendPlaintext(
                    JSONObject()
                        .put("type", "client_connect")
                        .put("username", target),
                )
            }
        }.onFailure(::fail)
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
        runCatching {
            check(transportKey == null) {
                "Plaintext message received after secure transport establishment"
            }
            val message = JSONObject(text)
            if (!relayPaired) {
                when (message.getString("type")) {
                    "client_connected" -> {
                        relayPaired = true
                        authentication.start(this)
                    }

                    "client_error" -> error(
                        "Relay connection failed: ${message.optString("reason", "unknown")}",
                    )

                    else -> error("Relay returned an unexpected pairing response")
                }
            } else {
                authentication.handle(this, message)
            }
        }.onFailure(::fail)
    }

    override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
        runCatching {
            val key = checkNotNull(transportKey) {
                "Binary message received before secure transport establishment"
            }
            val plaintext = checkNotNull(
                YaSecureTransportCrypto.decryptBinaryJson(
                    bytes.toByteArray(),
                    key,
                    secretBox,
                ),
            ) { "Encrypted response authentication failed" }
            val payload = JSONObject(plaintext)
            check(payload.length() == 2 && payload.has("seq") && payload.has("msg")) {
                "Encrypted response has an invalid sequence wrapper"
            }
            val sequence = payload.getLong("seq")
            check(sequence > lastInboundSequence) { "Encrypted response sequence replayed" }
            lastInboundSequence = sequence
            check(incoming.trySend(payload.getJSONObject("msg")).isSuccess) {
                "Native secure session is no longer accepting messages"
            }
        }.onFailure(::fail)
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
        webSocket.close(code, reason)
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        val normalOwnerClose = closeRequested && code == NORMAL_CLOSE_CODE
        terminate(
            if (normalOwnerClose) {
                null
            } else {
                IllegalStateException("YA WebSocket closed ($code): $reason")
            },
        )
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        terminate(if (closeRequested) null else t)
    }

    fun sendPlaintext(message: JSONObject) {
        check(!terminated.get()) { "Native secure session is closed" }
        check(transportKey == null)
        check(socket?.send(message.toString()) == true) {
            "WebSocket rejected plaintext authentication message"
        }
    }

    fun encryptProof(plaintext: String, key: ByteArray): String {
        return YaSecureTransportCrypto.encryptJsonEnvelope(plaintext, key, secretBox)
    }

    fun decryptProof(envelope: String, key: ByteArray): JSONObject {
        val plaintext = checkNotNull(
            YaSecureTransportCrypto.decryptJsonEnvelope(envelope, key, secretBox),
        ) { "YA server proof authentication failed" }
        return JSONObject(plaintext)
    }

    fun establish(
        credential: YaResumeCredential,
        resumed: Boolean,
        key: ByteArray,
    ) {
        check(transportKey == null)
        transportKey = key
        nextOutboundSequence = 0
        lastInboundSequence = -1
        authentication.clearSecrets()
        sendEncrypted(
            JSONObject()
                .put("type", "client_capabilities")
                .put("formats", JSONArray().put(YaSecureTransportCrypto.JSON_FORMAT)),
        )
        authenticated.complete(YaNativeSecureSession(this, credential, resumed))
    }

    fun sendEncrypted(message: JSONObject) {
        synchronized(sendLock) {
            check(!terminated.get()) { "Native secure session is closed" }
            val key = checkNotNull(transportKey) { "Native secure session is not authenticated" }
            val plaintext = JSONObject()
                .put("seq", nextOutboundSequence++)
                .put("msg", message)
                .toString()
            val envelope = YaSecureTransportCrypto.encryptBinaryJson(
                plaintext,
                key,
                secretBox,
            )
            check(socket?.send(envelope.toByteString()) == true) {
                "WebSocket rejected encrypted message"
            }
        }
    }

    fun requestClose() {
        if (terminated.get()) return
        closeRequested = true
        if (socket?.close(NORMAL_CLOSE_CODE, NORMAL_CLOSE_REASON) != true) {
            abort()
        }
    }

    fun abort() {
        closeRequested = true
        socket?.cancel()
        terminate(null)
    }

    private fun fail(error: Throwable) {
        socket?.cancel()
        terminate(error)
    }

    private fun terminate(error: Throwable?) {
        if (!terminated.compareAndSet(false, true)) return
        authentication.clearSecrets()
        transportKey?.fill(0)
        transportKey = null
        socket = null
        if (!authenticated.isCompleted) {
            if (error == null) {
                authenticated.completeExceptionally(
                    IllegalStateException("Native secure session closed during authentication"),
                )
            } else {
                authenticated.completeExceptionally(error)
            }
        }
        incoming.close(error)
        if (error == null) {
            closed.complete(Unit)
        } else {
            closed.completeExceptionally(error)
        }
    }

    companion object {
        private const val NORMAL_CLOSE_CODE = 1000
        private const val NORMAL_CLOSE_REASON = "Native owner released"
        private const val INCOMING_BUFFER_SIZE = 256
    }
}

internal interface Authentication {
    fun start(listener: SecureSessionListener)
    fun handle(listener: SecureSessionListener, message: JSONObject)
    fun clearSecrets()
}

private class FullLoginAuthentication(
    private val username: String,
    password: String,
) : Authentication {
    private var srpSession: YaSrpClientSession? = YaSrpClientSession(username, password)
    private var phase = Phase.CHALLENGE

    override fun start(listener: SecureSessionListener) {
        listener.sendPlaintext(
            JSONObject()
                .put("type", "srp_hello")
                .put("identity", username),
        )
    }

    override fun handle(listener: SecureSessionListener, message: JSONObject) {
        rejectSrpError(message)
        when (phase) {
            Phase.CHALLENGE -> {
                check(message.getString("type") == "srp_challenge")
                val proof = checkNotNull(srpSession).processChallenge(
                    message.getString("salt"),
                    message.getString("B"),
                )
                listener.sendPlaintext(
                    JSONObject()
                        .put("type", "srp_proof")
                        .put("A", proof.publicValueHex)
                        .put("M1", proof.evidenceHex),
                )
                phase = Phase.VERIFY
            }

            Phase.VERIFY -> {
                check(message.getString("type") == "srp_verify")
                val rawSessionKey = checkNotNull(srpSession).verifyServer(message.getString("M2"))
                srpSession = null
                val baseKey = YaSecureTransportCrypto.deriveBaseKey(rawSessionKey)
                rawSessionKey.fill(0)
                val sessionId = message.getString("sessionId")
                val transportNonceValue = message.getString("transportNonce")
                val serverInfo = listener.decryptProof(
                    message.getString("serverInfoProof"),
                    baseKey,
                )
                check(serverInfo.getString("type") == "srp_verify_server_info")
                check(serverInfo.getString("sessionId") == sessionId)
                check(serverInfo.getString("transportNonce") == transportNonceValue)
                val protocolVersion = serverInfo.getInt("resumeProtocolVersion")
                check(protocolVersion >= YaSecureTransportCrypto.RESUME_PROTOCOL_VERSION)
                val transportNonce = YaSecureTransportCrypto.decodeBase64(transportNonceValue)
                check(transportNonce.size == YaSecureTransportCrypto.NONCE_BYTES)
                val credential = YaResumeCredential(
                    username = username,
                    sessionId = sessionId,
                    baseKey = baseKey,
                    resumeProtocolVersion = protocolVersion,
                )
                phase = Phase.AUTHENTICATED
                try {
                    listener.establish(
                        credential = credential,
                        resumed = false,
                        key = YaSecureTransportCrypto.deriveTransportKey(baseKey, transportNonce),
                    )
                } finally {
                    baseKey.fill(0)
                    transportNonce.fill(0)
                }
            }

            Phase.AUTHENTICATED -> error("Unexpected plaintext after SRP authentication")
        }
    }

    override fun clearSecrets() {
        srpSession = null
    }

    private enum class Phase { CHALLENGE, VERIFY, AUTHENTICATED }
}

private class ResumeAuthentication(
    private val credential: YaResumeCredential,
) : Authentication {
    private val baseKey = credential.copyBaseKey()
    private val clientNonce = YaSecureTransportCrypto.encodeBase64(
        YaSecureTransportCrypto.randomNonce(),
    )
    private var serverNonce: String? = null
    private var phase = Phase.CHALLENGE

    override fun start(listener: SecureSessionListener) {
        listener.sendPlaintext(
            JSONObject()
                .put("type", "srp_resume_init")
                .put("identity", credential.username)
                .put("sessionId", credential.sessionId)
                .put("clientNonce", clientNonce),
        )
    }

    override fun handle(listener: SecureSessionListener, message: JSONObject) {
        rejectSrpError(message)
        if (message.optString("type") == "srp_invalid") {
            throw YaResumeRejectedException(message.optString("reason", "unknown"))
        }
        when (phase) {
            Phase.CHALLENGE -> {
                check(message.getString("type") == "srp_resume_challenge")
                check(message.getString("sessionId") == credential.sessionId)
                val nonce = message.getString("nonce")
                check(
                    YaSecureTransportCrypto.decodeBase64(nonce).size ==
                        YaSecureTransportCrypto.NONCE_BYTES,
                )
                serverNonce = nonce
                val proof = listener.encryptProof(
                    JSONObject()
                        .put("timestamp", System.currentTimeMillis())
                        .put("challenge", nonce)
                        .put("sessionId", credential.sessionId)
                        .toString(),
                    baseKey,
                )
                listener.sendPlaintext(
                    JSONObject()
                        .put("type", "srp_resume")
                        .put("identity", credential.username)
                        .put("sessionId", credential.sessionId)
                        .put("proof", proof),
                )
                phase = Phase.VERIFY
            }

            Phase.VERIFY -> {
                check(message.getString("type") == "srp_resumed")
                check(message.getString("sessionId") == credential.sessionId)
                val transportNonceValue = message.getString("transportNonce")
                check(transportNonceValue == serverNonce)
                val serverProof = listener.decryptProof(
                    message.getString("serverProof"),
                    baseKey,
                )
                check(serverProof.getString("type") == "srp_resume_server_proof")
                check(serverProof.getString("sessionId") == credential.sessionId)
                check(serverProof.getString("serverNonce") == serverNonce)
                check(serverProof.getString("clientNonce") == clientNonce)
                val protocolVersion = serverProof.getInt("resumeProtocolVersion")
                check(protocolVersion >= credential.resumeProtocolVersion)
                val transportNonce = YaSecureTransportCrypto.decodeBase64(transportNonceValue)
                phase = Phase.AUTHENTICATED
                try {
                    listener.establish(
                        credential = credential,
                        resumed = true,
                        key = YaSecureTransportCrypto.deriveTransportKey(baseKey, transportNonce),
                    )
                } finally {
                    transportNonce.fill(0)
                }
            }

            Phase.AUTHENTICATED -> error("Unexpected plaintext after SRP resume")
        }
    }

    override fun clearSecrets() {
        baseKey.fill(0)
    }

    private enum class Phase { CHALLENGE, VERIFY, AUTHENTICATED }
}

private fun rejectSrpError(message: JSONObject) {
    if (message.optString("type") == "srp_error") {
        error("YA server rejected native SRP authentication: ${message.optString("code")}")
    }
}
