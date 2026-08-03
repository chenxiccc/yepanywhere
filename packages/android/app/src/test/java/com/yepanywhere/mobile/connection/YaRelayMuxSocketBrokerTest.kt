package com.yepanywhere.mobile.connection

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.ByteString
import okio.ByteString.Companion.encodeUtf8
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class YaRelayMuxSocketBrokerTest {
    @Test
    fun `derives capability and mux endpoints from nested relay paths`() {
        assertEquals(
            RelayMuxEndpoints(
                key = "wss://relay.example:8443/nested",
                healthUrl = "https://relay.example:8443/nested/health",
                muxUrl = "wss://relay.example:8443/nested/mux",
            ),
            relayMuxEndpoints("wss://relay.example:8443/nested/ws"),
        )
        assertEquals(null, relayMuxEndpoints("https://relay.example/ws"))
        assertEquals(null, relayMuxEndpoints("wss://relay.example/other"))
    }

    @Test
    fun `small health response advertises mux without requiring a fixed body size`() =
        kotlinx.coroutines.runBlocking {
            val server = MockWebServer()
            server.enqueue(
                MockResponse().setBody(
                    """{"status":"ok","relayCapabilities":["client-mux-v1"]}""",
                ),
            )
            server.start()
            try {
                assertTrue(
                    relayMuxCapabilityProbe(OkHttpClient())(
                        server.url("/health").toString(),
                    ),
                )
            } finally {
                server.shutdown()
            }
        }

    @Test
    fun `one and then two hosts share one physical mux socket`() {
        val connector = FakeConnector()
        val broker = YaRelayMuxSocketBroker(
            httpClient = OkHttpClient(),
            legacyConnector = connector,
            capabilityProbe = { true },
        )
        val alpha = RecordingListener()
        val beta = RecordingListener()

        val alphaSocket = broker.open(RELAY_URL, "alpha", alpha)
        val physical = connector.awaitSocket { it.url.endsWith("/mux") }
        physical.activateMux()
        assertTrue(alpha.opened.await(2, TimeUnit.SECONDS))
        assertTrue(alpha.relayPaired)

        val betaSocket = broker.open(RELAY_URL, "beta", beta)
        assertTrue(beta.opened.await(2, TimeUnit.SECONDS))
        assertEquals(1, connector.sockets.count { it.url.endsWith("/mux") })
        assertEquals(
            setOf("alpha", "beta"),
            physical.controls
                .filter { it.optString("type") == "mux_open" }
                .map { it.getString("username") }
                .toSet(),
        )

        assertTrue(alphaSocket.send("alpha message"))
        assertTrue(betaSocket.send(byteArrayOf(1, 2, 3).let(ByteString::of)))
        physical.awaitDataFrames(2)
        val frames = physical.binaryFrames.map(::decodeRelayMuxFrame)
        assertEquals(setOf(false, true), frames.map { it.isBinary }.toSet())
        assertEquals(
            setOf("alpha message", "\u0001\u0002\u0003"),
            frames.map { it.payload.utf8() }.toSet(),
        )

        broker.close()
    }

    @Test
    fun `missing capability uses unchanged legacy relay handshake`() {
        val connector = FakeConnector()
        val broker = YaRelayMuxSocketBroker(
            httpClient = OkHttpClient(),
            legacyConnector = connector,
            capabilityProbe = { false },
        )
        val listener = RecordingListener()

        broker.open(RELAY_URL, "alpha", listener)
        val legacy = connector.awaitSocket { it.relayTarget == "alpha" }
        legacy.activateLegacy()

        assertTrue(listener.opened.await(2, TimeUnit.SECONDS))
        assertFalse(listener.relayPaired)
        assertEquals(RELAY_URL, legacy.url)
        assertEquals(0, connector.sockets.count { it.url.endsWith("/mux") })
        broker.close()
    }

    @Test
    fun `framing preserves unsigned ids payloads and binary flag`() {
        val payload = "hello".encodeUtf8()
        val encoded = encodeRelayMuxFrame(0xffff_ffffL, payload, isBinary = true)
        val decoded = decodeRelayMuxFrame(encoded)

        assertEquals(0xffff_ffffL, decoded.circuitId)
        assertTrue(decoded.isBinary)
        assertEquals(payload, decoded.payload)
        assertTrue(runCatching { decodeRelayMuxFrame(ByteString.EMPTY) }.isFailure)
        assertTrue(
            runCatching {
                decodeRelayMuxFrame(byteArrayOf(2, 0, 0, 0, 0, 1).let(ByteString::of))
            }.isFailure,
        )
    }

    @Test
    fun `mux circuit starts SRP without legacy relay pairing message`() {
        val authentication = RecordingAuthentication()
        val listener = SecureSessionListener(
            authentication = authentication,
            relayTarget = "alpha",
            secretBox = UnusedSecretBox,
        )
        val socket = StandaloneFakeSocket()

        listener.onOpen(socket, relayPaired = true)

        assertEquals(1, authentication.starts)
        assertTrue(socket.text.isEmpty())
    }

    @Test
    fun `legacy relay socket still sends client connect before SRP`() {
        val authentication = RecordingAuthentication()
        val listener = SecureSessionListener(
            authentication = authentication,
            relayTarget = "alpha",
            secretBox = UnusedSecretBox,
        )
        val socket = StandaloneFakeSocket()

        listener.onOpen(socket, relayPaired = false)

        assertEquals(0, authentication.starts)
        assertEquals("client_connect", JSONObject(socket.text.single()).getString("type"))
        assertEquals("alpha", JSONObject(socket.text.single()).getString("username"))
    }

    private class RecordingListener : YaClientSocketListener {
        val opened = CountDownLatch(1)
        var relayPaired = false

        override fun onOpen(socket: YaClientSocket, relayPaired: Boolean) {
            this.relayPaired = relayPaired
            opened.countDown()
        }

        override fun onText(socket: YaClientSocket, text: String) = Unit
        override fun onBytes(socket: YaClientSocket, bytes: ByteString) = Unit
        override fun onClosing(socket: YaClientSocket, code: Int, reason: String) = Unit
        override fun onClosed(socket: YaClientSocket, code: Int, reason: String) = Unit
        override fun onFailure(socket: YaClientSocket, error: Throwable) = Unit
    }

    private class RecordingAuthentication : Authentication {
        var starts = 0

        override fun start(listener: SecureSessionListener) {
            starts += 1
        }

        override fun handle(listener: SecureSessionListener, message: JSONObject) = Unit
        override fun clearSecrets() = Unit
    }

    private object UnusedSecretBox : YaSecretBox {
        override fun seal(message: ByteArray, nonce: ByteArray, key: ByteArray): ByteArray =
            error("Not used")

        override fun open(ciphertext: ByteArray, nonce: ByteArray, key: ByteArray): ByteArray? =
            error("Not used")
    }

    private class StandaloneFakeSocket : YaClientSocket {
        val text = mutableListOf<String>()

        override fun queueSize(): Long = 0
        override fun send(text: String): Boolean = this.text.add(text)
        override fun send(bytes: ByteString): Boolean = error("Not used")
        override fun close(code: Int, reason: String): Boolean = true
        override fun cancel() = Unit
    }

    private class FakeConnector : YaClientSocketConnector {
        private val lock = Object()
        val sockets = mutableListOf<FakeSocket>()

        override fun open(
            websocketUrl: String,
            relayTarget: String?,
            listener: YaClientSocketListener,
        ): YaClientSocket = synchronized(lock) {
            FakeSocket(websocketUrl, relayTarget, listener).also {
                sockets += it
                lock.notifyAll()
            }
        }

        fun awaitSocket(predicate: (FakeSocket) -> Boolean): FakeSocket {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
            synchronized(lock) {
                while (true) {
                    sockets.firstOrNull(predicate)?.let { return it }
                    val remaining = deadline - System.nanoTime()
                    assertTrue("Timed out waiting for socket", remaining > 0)
                    TimeUnit.NANOSECONDS.timedWait(lock, remaining)
                }
            }
        }
    }

    private class FakeSocket(
        val url: String,
        val relayTarget: String?,
        private val listener: YaClientSocketListener,
    ) : YaClientSocket {
        val controls = mutableListOf<JSONObject>()
        val binaryFrames = mutableListOf<ByteString>()
        private val binaryLock = Object()
        private var closed = false

        fun activateMux() {
            listener.onOpen(this, relayPaired = true)
            listener.onText(
                this,
                JSONObject()
                    .put("type", "mux_ready")
                    .put("protocolVersion", 1)
                    .put("maxCircuits", 5)
                    .put("maxFrameBytes", 2 * 1024 * 1024)
                    .toString(),
            )
        }

        fun activateLegacy() {
            listener.onOpen(this, relayPaired = false)
        }

        fun awaitDataFrames(count: Int) {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
            synchronized(binaryLock) {
                while (binaryFrames.size < count) {
                    val remaining = deadline - System.nanoTime()
                    assertTrue("Timed out waiting for frames", remaining > 0)
                    TimeUnit.NANOSECONDS.timedWait(binaryLock, remaining)
                }
            }
        }

        override fun queueSize(): Long = 0

        override fun send(text: String): Boolean {
            if (closed) return false
            val message = JSONObject(text)
            synchronized(controls) { controls += message }
            if (message.optString("type") == "mux_open") {
                listener.onText(
                    this,
                    JSONObject()
                        .put("type", "mux_opened")
                        .put("circuitId", message.getLong("circuitId"))
                        .toString(),
                )
            }
            return true
        }

        override fun send(bytes: ByteString): Boolean {
            if (closed) return false
            synchronized(binaryLock) {
                binaryFrames += bytes
                binaryLock.notifyAll()
            }
            return true
        }

        override fun close(code: Int, reason: String): Boolean {
            if (closed) return false
            closed = true
            listener.onClosed(this, code, reason)
            return true
        }

        override fun cancel() {
            if (closed) return
            closed = true
            listener.onFailure(this, IllegalStateException("cancelled"))
        }
    }

    companion object {
        private const val RELAY_URL = "wss://relay.example/ws"
    }
}
