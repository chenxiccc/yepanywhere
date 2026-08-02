package com.yepanywhere.mobile.connection

import java.io.Closeable
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine
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

/**
 * Minimal direct YA secure-transport client used to establish the native wire
 * foundation. It owns one WebSocket attempt and proves encrypted ping/pong;
 * connection-manager leases and general request/subscription routing follow
 * after the protocol checkpoint.
 */
class YaNativeSecureConnection(
    private val httpClient: OkHttpClient,
    private val secretBoxFactory: () -> YaSecretBox = ::LazySodiumSecretBox,
) {
    suspend fun loginAndProbe(
        wsUrl: String,
        username: String,
        password: String,
    ): YaSecureProbeResult {
        require(username.isNotBlank())
        require(password.isNotEmpty())
        val request = Request.Builder().url(wsUrl).build()
        return awaitProbe(request) { continuation ->
            FullLoginListener(
                username = username,
                password = password,
                secretBox = secretBoxFactory(),
                continuation = continuation,
            )
        }
    }

    suspend fun resumeAndProbe(
        wsUrl: String,
        credential: YaResumeCredential,
    ): YaSecureProbeResult {
        val request = Request.Builder().url(wsUrl).build()
        return awaitProbe(request) { continuation ->
            ResumeListener(
                credential = credential,
                secretBox = secretBoxFactory(),
                continuation = continuation,
            )
        }
    }

    private suspend fun awaitProbe(
        request: Request,
        listenerFactory: (ProbeContinuation) -> ProbeListener,
    ): YaSecureProbeResult {
        return suspendCancellableCoroutine { continuation ->
            val completion = ProbeContinuation(
                success = { result ->
                    if (continuation.isActive) continuation.resume(result)
                },
                failure = { error ->
                    if (continuation.isActive) continuation.resumeWithException(error)
                },
            )
            val listener = listenerFactory(completion)
            val socket = httpClient.newWebSocket(request, listener)
            continuation.invokeOnCancellation { socket.cancel() }
        }
    }

    private class ProbeContinuation(
        private val success: (YaSecureProbeResult) -> Unit,
        private val failure: (Throwable) -> Unit,
    ) {
        private val completed = AtomicBoolean(false)

        fun succeed(result: YaSecureProbeResult): Boolean {
            if (!completed.compareAndSet(false, true)) return false
            success(result)
            return true
        }

        fun fail(error: Throwable): Boolean {
            if (!completed.compareAndSet(false, true)) return false
            failure(error)
            return true
        }

        fun isCompleted(): Boolean = completed.get()
    }

    private abstract class ProbeListener(
        protected val secretBox: YaSecretBox,
        private val continuation: ProbeContinuation,
    ) : WebSocketListener(), Closeable {
        protected var transportKey: ByteArray? = null
        private var nextOutboundSequence = 0L
        private var lastInboundSequence = -1L
        private var expectedPongId: String? = null
        private var socket: WebSocket? = null
        private var completedResult: YaSecureProbeResult? = null

        final override fun onOpen(webSocket: WebSocket, response: Response) {
            socket = webSocket
            runCatching { start(webSocket) }.onFailure(::fail)
        }

        final override fun onMessage(webSocket: WebSocket, text: String) {
            runCatching {
                if (transportKey != null) {
                    error("Plaintext message received after secure transport establishment")
                }
                handleHandshakeMessage(webSocket, JSONObject(text))
            }.onFailure(::fail)
        }

        final override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
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
                val message = payload.getJSONObject("msg")
                val pongId = expectedPongId
                check(message.getString("type") == "pong" && message.getString("id") == pongId) {
                    "Native secure probe received an unexpected message"
                }
                expectedPongId = null
                completedResult = result()
                check(webSocket.close(NORMAL_CLOSE_CODE, "Native secure probe complete")) {
                    "WebSocket rejected native secure probe close"
                }
            }.onFailure(::fail)
        }

        final override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(code, reason)
            if (completedResult == null && !continuation.isCompleted()) {
                fail(IllegalStateException("WebSocket closed before native secure probe completed"))
            }
        }

        final override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            val result = completedResult
            clearAttemptState()
            if (result != null && code == NORMAL_CLOSE_CODE) {
                continuation.succeed(result)
            } else if (!continuation.isCompleted()) {
                fail(IllegalStateException("WebSocket closed before native secure probe completed"))
            }
        }

        final override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            fail(t)
        }

        protected abstract fun start(webSocket: WebSocket)
        protected abstract fun handleHandshakeMessage(webSocket: WebSocket, message: JSONObject)
        protected abstract fun result(): YaSecureProbeResult

        protected fun establishTransport(webSocket: WebSocket, key: ByteArray) {
            check(transportKey == null)
            transportKey = key
            nextOutboundSequence = 0
            lastInboundSequence = -1
            sendEncrypted(
                webSocket,
                JSONObject()
                    .put("type", "client_capabilities")
                    .put("formats", JSONArray().put(YaSecureTransportCrypto.JSON_FORMAT)),
            )
            val pongId = "android-native-${YaSecureTransportCrypto.encodeBase64(
                YaSecureTransportCrypto.randomNonce(),
            )}"
            expectedPongId = pongId
            sendEncrypted(
                webSocket,
                JSONObject().put("type", "ping").put("id", pongId),
            )
        }

        private fun sendEncrypted(webSocket: WebSocket, message: JSONObject) {
            val key = checkNotNull(transportKey)
            val plaintext = JSONObject()
                .put("seq", nextOutboundSequence++)
                .put("msg", message)
                .toString()
            val envelope = YaSecureTransportCrypto.encryptBinaryJson(
                plaintext,
                key,
                secretBox,
            )
            check(webSocket.send(envelope.toByteString())) { "WebSocket rejected encrypted message" }
        }

        protected fun fail(error: Throwable) {
            if (continuation.fail(error)) close()
        }

        override fun close() {
            socket?.cancel()
            socket = null
            clearAttemptState()
        }

        protected open fun clearAttemptSecrets() = Unit

        private fun clearAttemptState() {
            transportKey?.fill(0)
            transportKey = null
            expectedPongId = null
            completedResult = null
            clearAttemptSecrets()
        }
    }

    private class FullLoginListener(
        private val username: String,
        password: String,
        secretBox: YaSecretBox,
        continuation: ProbeContinuation,
    ) : ProbeListener(secretBox, continuation) {
        private var srpSession: YaSrpClientSession? = YaSrpClientSession(username, password)
        private var credential: YaResumeCredential? = null
        private var phase = Phase.CHALLENGE

        override fun start(webSocket: WebSocket) {
            check(
                webSocket.send(
                    JSONObject()
                        .put("type", "srp_hello")
                        .put("identity", username)
                        .toString(),
                ),
            )
        }

        override fun handleHandshakeMessage(webSocket: WebSocket, message: JSONObject) {
            rejectSrpError(message)
            when (phase) {
                Phase.CHALLENGE -> {
                    check(message.getString("type") == "srp_challenge")
                    val proof = checkNotNull(srpSession).processChallenge(
                        message.getString("salt"),
                        message.getString("B"),
                    )
                    check(
                        webSocket.send(
                            JSONObject()
                                .put("type", "srp_proof")
                                .put("A", proof.publicValueHex)
                                .put("M1", proof.evidenceHex)
                                .toString(),
                        ),
                    )
                    phase = Phase.VERIFY
                }

                Phase.VERIFY -> {
                    check(message.getString("type") == "srp_verify")
                    val rawSessionKey = checkNotNull(srpSession).verifyServer(
                        message.getString("M2"),
                    )
                    srpSession = null
                    val baseKey = YaSecureTransportCrypto.deriveBaseKey(rawSessionKey)
                    rawSessionKey.fill(0)
                    val sessionId = message.getString("sessionId")
                    val transportNonceValue = message.getString("transportNonce")
                    val serverInfo = decryptProofObject(
                        message.getString("serverInfoProof"),
                        baseKey,
                        secretBox,
                    )
                    check(serverInfo.getString("type") == "srp_verify_server_info")
                    check(serverInfo.getString("sessionId") == sessionId)
                    check(serverInfo.getString("transportNonce") == transportNonceValue)
                    val protocolVersion = serverInfo.getInt("resumeProtocolVersion")
                    check(protocolVersion >= YaSecureTransportCrypto.RESUME_PROTOCOL_VERSION)
                    val transportNonce = YaSecureTransportCrypto.decodeBase64(transportNonceValue)
                    check(transportNonce.size == YaSecureTransportCrypto.NONCE_BYTES)
                    credential = YaResumeCredential(
                        username = username,
                        sessionId = sessionId,
                        baseKey = baseKey,
                        resumeProtocolVersion = protocolVersion,
                    )
                    phase = Phase.PROBE
                    try {
                        establishTransport(
                            webSocket,
                            YaSecureTransportCrypto.deriveTransportKey(baseKey, transportNonce),
                        )
                    } finally {
                        baseKey.fill(0)
                        transportNonce.fill(0)
                    }
                }

                Phase.PROBE -> error("Unexpected plaintext during encrypted probe")
            }
        }

        override fun result(): YaSecureProbeResult {
            return YaSecureProbeResult(checkNotNull(credential), resumed = false)
        }

        override fun clearAttemptSecrets() {
            srpSession = null
        }

        private enum class Phase { CHALLENGE, VERIFY, PROBE }
    }

    private class ResumeListener(
        private val credential: YaResumeCredential,
        secretBox: YaSecretBox,
        continuation: ProbeContinuation,
    ) : ProbeListener(secretBox, continuation) {
        private val baseKey = credential.copyBaseKey()
        private val clientNonce = YaSecureTransportCrypto.encodeBase64(
            YaSecureTransportCrypto.randomNonce(),
        )
        private var serverNonce: String? = null
        private var phase = Phase.CHALLENGE

        override fun start(webSocket: WebSocket) {
            check(
                webSocket.send(
                    JSONObject()
                        .put("type", "srp_resume_init")
                        .put("identity", credential.username)
                        .put("sessionId", credential.sessionId)
                        .put("clientNonce", clientNonce)
                        .toString(),
                ),
            )
        }

        override fun handleHandshakeMessage(webSocket: WebSocket, message: JSONObject) {
            rejectSrpError(message)
            check(message.optString("type") != "srp_invalid") { "Native resume credential rejected" }
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
                    val proofPlaintext = JSONObject()
                        .put("timestamp", System.currentTimeMillis())
                        .put("challenge", nonce)
                        .put("sessionId", credential.sessionId)
                        .toString()
                    val proof = YaSecureTransportCrypto.encryptJsonEnvelope(
                        proofPlaintext,
                        baseKey,
                        secretBox,
                    )
                    check(
                        webSocket.send(
                            JSONObject()
                                .put("type", "srp_resume")
                                .put("identity", credential.username)
                                .put("sessionId", credential.sessionId)
                                .put("proof", proof)
                                .toString(),
                        ),
                    )
                    phase = Phase.VERIFY
                }

                Phase.VERIFY -> {
                    check(message.getString("type") == "srp_resumed")
                    check(message.getString("sessionId") == credential.sessionId)
                    val transportNonceValue = message.getString("transportNonce")
                    check(transportNonceValue == serverNonce)
                    val serverProof = decryptProofObject(
                        message.getString("serverProof"),
                        baseKey,
                        secretBox,
                    )
                    check(serverProof.getString("type") == "srp_resume_server_proof")
                    check(serverProof.getString("sessionId") == credential.sessionId)
                    check(serverProof.getString("serverNonce") == serverNonce)
                    check(serverProof.getString("clientNonce") == clientNonce)
                    val protocolVersion = serverProof.getInt("resumeProtocolVersion")
                    check(protocolVersion >= credential.resumeProtocolVersion)
                    phase = Phase.PROBE
                    establishTransport(
                        webSocket,
                        YaSecureTransportCrypto.deriveTransportKey(
                            baseKey,
                            YaSecureTransportCrypto.decodeBase64(transportNonceValue),
                        ),
                    )
                }

                Phase.PROBE -> error("Unexpected plaintext during encrypted probe")
            }
        }

        override fun result(): YaSecureProbeResult {
            return YaSecureProbeResult(credential, resumed = true)
        }

        override fun clearAttemptSecrets() {
            baseKey.fill(0)
        }

        private enum class Phase { CHALLENGE, VERIFY, PROBE }
    }

    companion object {
        private const val NORMAL_CLOSE_CODE = 1000

        private fun rejectSrpError(message: JSONObject) {
            if (message.optString("type") == "srp_error") {
                error("YA server rejected native SRP authentication: ${message.optString("code")}")
            }
        }

        private fun decryptProofObject(
            envelope: String,
            key: ByteArray,
            secretBox: YaSecretBox,
        ): JSONObject {
            val plaintext = checkNotNull(
                YaSecureTransportCrypto.decryptJsonEnvelope(envelope, key, secretBox),
            ) { "YA server proof authentication failed" }
            return JSONObject(plaintext)
        }
    }
}
