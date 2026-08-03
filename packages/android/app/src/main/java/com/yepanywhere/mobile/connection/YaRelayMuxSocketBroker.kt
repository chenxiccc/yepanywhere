package com.yepanywhere.mobile.connection

import java.io.Closeable
import java.net.URI
import java.util.ArrayDeque
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okio.Buffer
import okio.ByteString
import okio.ByteString.Companion.encodeUtf8
import org.json.JSONObject

/**
 * Shares one relay `/mux` WebSocket between independently authenticated YA
 * profile connections. Capability discovery and mux setup failures fall back
 * to the unchanged legacy `/ws` connector; circuit-scoped failures do not.
 */
internal class YaRelayMuxSocketBroker(
    httpClient: OkHttpClient,
    private val legacyConnector: YaClientSocketConnector,
    private val capabilityProbe: suspend (String) -> Boolean =
        relayMuxCapabilityProbe(httpClient),
) : YaClientSocketConnector, Closeable {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val lock = Any()
    private val groups = mutableMapOf<String, RelayMuxGroup>()
    private var closed = false

    override fun open(
        websocketUrl: String,
        relayTarget: String?,
        listener: YaClientSocketListener,
    ): YaClientSocket {
        if (relayTarget == null) {
            return legacyConnector.open(websocketUrl, null, listener)
        }
        val endpoints = relayMuxEndpoints(websocketUrl)
            ?: return legacyConnector.open(websocketUrl, relayTarget, listener)
        val pending = DeferredClientSocket(listener)
        val group = synchronized(lock) {
            if (closed) null else groups.getOrPut(endpoints.key) {
                RelayMuxGroup(
                    endpoints = endpoints,
                    capabilityProbe = capabilityProbe,
                    legacyConnector = legacyConnector,
                    scope = scope,
                )
            }
        }
        if (group == null) {
            pending.fail(IllegalStateException("Relay mux broker is closed"))
            return pending
        }
        scope.launch {
            group.open(websocketUrl, relayTarget, pending, listener)
        }
        return pending
    }

    override fun close() {
        val ownedGroups = synchronized(lock) {
            if (closed) return
            closed = true
            groups.values.toList().also { groups.clear() }
        }
        ownedGroups.forEach(RelayMuxGroup::close)
        scope.cancel()
    }
}

internal data class RelayMuxEndpoints(
    val key: String,
    val healthUrl: String,
    val muxUrl: String,
)

internal fun relayMuxEndpoints(rawRelayUrl: String): RelayMuxEndpoints? {
    val relay = runCatching { URI(rawRelayUrl) }.getOrNull() ?: return null
    if (relay.scheme != "ws" && relay.scheme != "wss") return null
    if (relay.host == null || relay.userInfo != null || relay.fragment != null) return null
    if (relay.rawQuery != null || !relay.path.endsWith("/ws")) return null
    val basePath = relay.rawPath.removeSuffix("/ws")
    val authority = relay.rawAuthority ?: return null
    val httpScheme = if (relay.scheme == "wss") "https" else "http"
    return RelayMuxEndpoints(
        key = "${relay.scheme}://$authority$basePath",
        healthUrl = "$httpScheme://$authority$basePath/health",
        muxUrl = "${relay.scheme}://$authority$basePath/mux",
    )
}

private fun relayMuxCapabilityProbe(
    httpClient: OkHttpClient,
): suspend (String) -> Boolean = { healthUrl ->
    withContext(Dispatchers.IO) {
        val call = httpClient.newCall(Request.Builder().url(healthUrl).build())
        call.timeout().timeout(DISCOVERY_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        runCatching {
            call.execute().use { response ->
                if (!response.isSuccessful) return@use false
                val source = response.body?.source() ?: return@use false
                val body = source.readUtf8(MAX_HEALTH_RESPONSE_BYTES + 1L)
                if (body.toByteArray().size > MAX_HEALTH_RESPONSE_BYTES) return@use false
                val capabilities = JSONObject(body).optJSONArray("relayCapabilities")
                    ?: return@use false
                (0 until capabilities.length()).any { index ->
                    capabilities.optString(index) == RELAY_CLIENT_MUX_V1_CAPABILITY
                }
            }
        }.getOrDefault(false)
    }
}

private class RelayMuxGroup(
    private val endpoints: RelayMuxEndpoints,
    private val capabilityProbe: suspend (String) -> Boolean,
    private val legacyConnector: YaClientSocketConnector,
    private val scope: CoroutineScope,
) : Closeable {
    private val physicalLock = Mutex()
    private val discoveryLock = Any()
    private var discovery: kotlinx.coroutines.Deferred<Boolean>? = null
    private var physical: RelayMuxPhysicalConnection? = null
    @Volatile
    private var degraded = false
    @Volatile
    private var closed = false

    suspend fun open(
        websocketUrl: String,
        relayTarget: String,
        pending: DeferredClientSocket,
        listener: YaClientSocketListener,
    ) {
        if (closed || pending.isTerminal()) return
        if (degraded || !discover()) {
            openLegacy(websocketUrl, relayTarget, pending, listener)
            return
        }

        val mux = try {
            ensurePhysical()
        } catch (_: Throwable) {
            if (closed || pending.isTerminal()) return
            degraded = true
            openLegacy(websocketUrl, relayTarget, pending, listener)
            return
        }
        if (closed || pending.isTerminal()) return
        runCatching { mux.openCircuit(relayTarget, pending, listener) }
            .onFailure(pending::fail)
    }

    override fun close() {
        closed = true
        physical?.close(1000, "Mux broker disposed")
        physical = null
    }

    private suspend fun discover(): Boolean {
        val lookup = synchronized(discoveryLock) {
            discovery ?: scope.async { capabilityProbe(endpoints.healthUrl) }
                .also { discovery = it }
        }
        return runCatching { lookup.await() }.getOrDefault(false)
    }

    private suspend fun ensurePhysical(): RelayMuxPhysicalConnection = physicalLock.withLock {
        physical?.takeIf { it.isUsable() }?.also { it.cancelIdleClose() }?.let { return it }
        if (closed) throw IllegalStateException("Relay mux group is closed")
        lateinit var opened: RelayMuxPhysicalConnection
        opened = RelayMuxPhysicalConnection(
            muxUrl = endpoints.muxUrl,
            connector = legacyConnector,
            scope = scope,
            onTerminated = {
                scope.launch {
                    physicalLock.withLock {
                        if (physical === opened) physical = null
                    }
                }
            },
        )
        physical = opened
        try {
            opened.startAndAwaitReady()
            opened
        } catch (error: Throwable) {
            if (physical === opened) physical = null
            opened.close(1008, "Relay mux setup failed")
            throw error
        }
    }

    private fun openLegacy(
        websocketUrl: String,
        relayTarget: String,
        pending: DeferredClientSocket,
        listener: YaClientSocketListener,
    ) {
        if (closed || pending.isTerminal()) return
        try {
            val delegate = legacyConnector.open(
                websocketUrl,
                relayTarget,
                ForwardingClientSocketListener(pending, listener),
            )
            pending.attach(delegate)
        } catch (error: Throwable) {
            pending.fail(error)
        }
    }
}

private class DeferredClientSocket(
    private val listener: YaClientSocketListener,
) : YaClientSocket {
    private val lock = Any()
    private var delegate: YaClientSocket? = null
    private var terminal = false
    private var closeRequest: Pair<Int, String>? = null
    private var cancelRequested = false

    fun attach(socket: YaClientSocket) {
        val action = synchronized(lock) {
            if (delegate != null) return
            delegate = socket
            when {
                cancelRequested -> AttachAction.Cancel
                closeRequest != null -> AttachAction.Close(checkNotNull(closeRequest))
                else -> AttachAction.None
            }
        }
        when (action) {
            AttachAction.Cancel -> socket.cancel()
            is AttachAction.Close -> socket.close(action.request.first, action.request.second)
            AttachAction.None -> Unit
        }
    }

    fun isTerminal(): Boolean = synchronized(lock) { terminal || cancelRequested }

    fun fail(error: Throwable) {
        if (markTerminal()) listener.onFailure(this, error)
    }

    fun closed(code: Int, reason: String) {
        if (markTerminal()) listener.onClosed(this, code, reason)
    }

    fun markTerminal(): Boolean = synchronized(lock) {
        if (terminal) return false
        terminal = true
        true
    }

    override fun queueSize(): Long = synchronized(lock) { delegate?.queueSize() ?: 0L }

    override fun send(text: String): Boolean = synchronized(lock) {
        if (terminal || cancelRequested) false else delegate?.send(text) ?: false
    }

    override fun send(bytes: ByteString): Boolean = synchronized(lock) {
        if (terminal || cancelRequested) false else delegate?.send(bytes) ?: false
    }

    override fun close(code: Int, reason: String): Boolean {
        val socket = synchronized(lock) {
            if (terminal || cancelRequested || closeRequest != null) return false
            closeRequest = code to reason
            delegate
        }
        return socket?.close(code, reason) ?: true
    }

    override fun cancel() {
        val socket = synchronized(lock) {
            if (cancelRequested) return
            cancelRequested = true
            terminal = true
            delegate
        }
        socket?.cancel()
    }

    private sealed interface AttachAction {
        data object None : AttachAction
        data object Cancel : AttachAction
        data class Close(val request: Pair<Int, String>) : AttachAction
    }
}

private class ForwardingClientSocketListener(
    private val pending: DeferredClientSocket,
    private val listener: YaClientSocketListener,
) : YaClientSocketListener {
    override fun onOpen(socket: YaClientSocket, relayPaired: Boolean) {
        if (!pending.isTerminal()) listener.onOpen(pending, relayPaired)
    }

    override fun onText(socket: YaClientSocket, text: String) {
        if (!pending.isTerminal()) listener.onText(pending, text)
    }

    override fun onBytes(socket: YaClientSocket, bytes: ByteString) {
        if (!pending.isTerminal()) listener.onBytes(pending, bytes)
    }

    override fun onClosing(socket: YaClientSocket, code: Int, reason: String) {
        if (!pending.isTerminal()) listener.onClosing(pending, code, reason)
    }

    override fun onClosed(socket: YaClientSocket, code: Int, reason: String) {
        pending.closed(code, reason)
    }

    override fun onFailure(socket: YaClientSocket, error: Throwable) {
        pending.fail(error)
    }
}

private class RelayMuxPhysicalConnection(
    private val muxUrl: String,
    private val connector: YaClientSocketConnector,
    private val scope: CoroutineScope,
    private val onTerminated: () -> Unit,
) : YaClientSocketListener {
    private val lock = Any()
    private val ready = CompletableDeferred<Unit>()
    private val pending = mutableMapOf<Long, PendingCircuit>()
    private val circuits = mutableMapOf<Long, RelayMuxCircuitSocket>()
    private val queues = mutableMapOf<Long, ArrayDeque<QueuedFrame>>()
    private val queuedBytesByCircuit = mutableMapOf<Long, Long>()
    private val circuitOrder = mutableListOf<Long>()
    private var socket: YaClientSocket? = null
    private var readyTimeout: Job? = null
    private var idleClose: Job? = null
    private var drainJob: Job? = null
    private var queuedBytes = 0L
    private var drainCursor = 0
    private var maxFrameBytes = 0
    private var maxCircuits = 0
    private var nextCircuitId = 1L
    private var closing = false
    private var terminated = false

    suspend fun startAndAwaitReady() {
        val opened = connector.open(muxUrl, null, this)
        val closeAfterAttach = synchronized(lock) {
            socket = opened
            closing || terminated
        }
        if (closeAfterAttach) {
            if (!opened.close(1008, "Relay mux setup ended")) opened.cancel()
        }
        readyTimeout = scope.launch {
            delay(MUX_READY_TIMEOUT_MS)
            if (!ready.isCompleted) {
                ready.completeExceptionally(IllegalStateException("Relay mux ready timeout"))
                close(1008, "Relay mux ready timeout")
            }
        }
        ready.await()
    }

    fun isUsable(): Boolean = synchronized(lock) {
        !terminated && !closing && ready.isCompleted && !ready.isCancelled
    }

    fun cancelIdleClose() {
        synchronized(lock) {
            idleClose?.cancel()
            idleClose = null
        }
    }

    fun openCircuit(
        username: String,
        wrapper: DeferredClientSocket,
        listener: YaClientSocketListener,
    ) {
        val circuit: RelayMuxCircuitSocket
        val circuitId: Long
        synchronized(lock) {
            check(!terminated && !closing && ready.isCompleted) {
                "Relay mux is not connected"
            }
            check(circuits.size + pending.size < maxCircuits) {
                "Relay mux circuit limit reached"
            }
            idleClose?.cancel()
            idleClose = null
            circuitId = allocateCircuitIdLocked()
            circuit = RelayMuxCircuitSocket(this, circuitId, wrapper, listener)
            wrapper.attach(circuit)
            val timeout = scope.launch {
                delay(MUX_OPEN_TIMEOUT_MS)
                failPendingCircuit(circuitId, IllegalStateException("Waiting for relay circuit timed out"))
            }
            pending[circuitId] = PendingCircuit(circuit, timeout)
        }
        if (!sendControl(
                JSONObject()
                    .put("type", "mux_open")
                    .put("circuitId", circuitId)
                    .put("username", username)
                    .put("channel", "app"),
            )
        ) {
            failPendingCircuit(circuitId, IllegalStateException("Relay mux disconnected"))
        }
    }

    fun enqueue(circuitId: Long, payload: ByteString, isBinary: Boolean): Boolean {
        val frame = encodeRelayMuxFrame(circuitId, payload, isBinary)
        synchronized(lock) {
            if (terminated || closing || !circuits.containsKey(circuitId)) return false
            if (payload.size > maxFrameBytes) {
                scope.launch { closeCircuit(circuitId, 1008, "Relay mux frame is too large") }
                return false
            }
            val circuitBytes = queuedBytesByCircuit[circuitId] ?: 0L
            if (
                circuitBytes + frame.size > CLIENT_QUEUE_BYTES_PER_CIRCUIT ||
                queuedBytes + frame.size > CLIENT_QUEUE_BYTES_PER_SOCKET
            ) {
                scope.launch { closeCircuit(circuitId, 1008, "Relay mux queue overflow") }
                return false
            }
            val queue = queues.getOrPut(circuitId) {
                circuitOrder += circuitId
                ArrayDeque()
            }
            queue += QueuedFrame(frame)
            queuedBytesByCircuit[circuitId] = circuitBytes + frame.size
            queuedBytes += frame.size
            ensureDrainLocked()
            return true
        }
    }

    fun queueSize(circuitId: Long): Long = synchronized(lock) {
        (queuedBytesByCircuit[circuitId] ?: 0L) + (socket?.queueSize() ?: 0L)
    }

    fun requestCircuitClose(circuitId: Long, code: Int, reason: String): Boolean {
        val exists = synchronized(lock) {
            circuits[circuitId]?.markClosing() == true || pending.containsKey(circuitId)
        }
        if (!exists) return false
        sendControl(JSONObject().put("type", "mux_close").put("circuitId", circuitId))
        scope.launch {
            delay(CIRCUIT_CLOSE_TIMEOUT_MS)
            closeCircuit(circuitId, code, reason.ifBlank { "Circuit close timeout" })
        }
        return true
    }

    fun cancelCircuit(circuitId: Long) {
        sendControl(JSONObject().put("type", "mux_close").put("circuitId", circuitId))
        removeCircuit(circuitId, notify = false, code = 1000, reason = "Cancelled")
    }

    fun close(code: Int, reason: String) {
        val owned = synchronized(lock) {
            if (terminated || closing) return
            closing = true
            socket
        }
        if (owned?.close(code, reason) != true) owned?.cancel()
    }

    override fun onOpen(socket: YaClientSocket, relayPaired: Boolean) = Unit

    override fun onText(socket: YaClientSocket, text: String) {
        val message = runCatching { JSONObject(text) }.getOrNull()
        if (message == null) {
            protocolError("Invalid relay mux control")
            return
        }
        val type = message.optString("type")
        if (!ready.isCompleted) {
            if (type != "mux_ready" || message.optInt("protocolVersion") != MUX_PROTOCOL_VERSION) {
                protocolError("Expected relay mux ready")
                return
            }
            val announcedCircuits = message.optInt("maxCircuits")
            val announcedFrameBytes = message.optInt("maxFrameBytes")
            if (announcedCircuits <= 0 || announcedFrameBytes <= 0) {
                protocolError("Invalid relay mux limits")
                return
            }
            synchronized(lock) {
                maxCircuits = announcedCircuits
                maxFrameBytes = announcedFrameBytes
            }
            readyTimeout?.cancel()
            ready.complete(Unit)
            return
        }

        when (type) {
            "mux_ready" -> {
                if (
                    message.optInt("protocolVersion") != MUX_PROTOCOL_VERSION ||
                    message.optInt("maxCircuits") <= 0 ||
                    message.optInt("maxFrameBytes") <= 0
                ) {
                    protocolError("Invalid relay mux ready")
                }
            }
            "mux_opened" -> handleOpened(message.optLong("circuitId"))
            "mux_error" -> handleCircuitError(
                message.optLong("circuitId"),
                message.optString("reason"),
            )
            "mux_closed" -> handleCircuitClosed(
                message.optLong("circuitId"),
                message.optString("reason"),
            )
            else -> protocolError("Unexpected relay mux control")
        }
    }

    override fun onBytes(socket: YaClientSocket, bytes: ByteString) {
        val frame = runCatching { decodeRelayMuxFrame(bytes) }.getOrNull()
        if (frame == null) {
            protocolError("Invalid relay mux data")
            return
        }
        val circuit = synchronized(lock) {
            if (frame.payload.size > maxFrameBytes) null else circuits[frame.circuitId]
        }
        if (frame.payload.size > maxFrameBytes) {
            closeCircuit(frame.circuitId, 1008, "Relay mux frame is too large")
        } else {
            circuit?.receive(frame.payload, frame.isBinary)
        }
    }

    override fun onClosing(socket: YaClientSocket, code: Int, reason: String) {
        socket.close(code, reason)
    }

    override fun onClosed(socket: YaClientSocket, code: Int, reason: String) {
        terminate(null, code, reason.ifBlank { "Relay mux disconnected" })
    }

    override fun onFailure(socket: YaClientSocket, error: Throwable) {
        terminate(error, 1006, error.message ?: "Relay mux disconnected")
    }

    private fun handleOpened(circuitId: Long) {
        if (!isValidCircuitId(circuitId)) {
            protocolError("Invalid relay mux circuit id")
            return
        }
        val circuit = synchronized(lock) {
            val opening = pending.remove(circuitId)
            if (opening == null) return@synchronized null
            opening.timeout.cancel()
            circuits[circuitId] = opening.circuit
            opening.circuit
        }
        if (circuit == null) {
            sendControl(JSONObject().put("type", "mux_close").put("circuitId", circuitId))
        } else {
            circuit.opened()
        }
    }

    private fun handleCircuitError(circuitId: Long, reason: String) {
        if (!isValidCircuitId(circuitId) || reason !in MUX_ERROR_REASONS) {
            protocolError("Invalid relay mux error")
            return
        }
        failPendingCircuit(circuitId, RelayMuxCircuitOpenException(reason))
    }

    private fun handleCircuitClosed(circuitId: Long, reason: String) {
        if (!isValidCircuitId(circuitId) || reason !in MUX_CLOSED_REASONS) {
            protocolError("Invalid relay mux close")
            return
        }
        removeCircuit(circuitId, notify = true, code = 1000, reason = reason)
    }

    private fun failPendingCircuit(circuitId: Long, error: Throwable) {
        val circuit = synchronized(lock) {
            val opening = pending.remove(circuitId) ?: return
            opening.timeout.cancel()
            scheduleIdleCloseLocked()
            opening.circuit
        }
        sendControl(JSONObject().put("type", "mux_close").put("circuitId", circuitId))
        circuit.failed(error)
    }

    private fun closeCircuit(circuitId: Long, code: Int, reason: String) {
        sendControl(JSONObject().put("type", "mux_close").put("circuitId", circuitId))
        removeCircuit(circuitId, notify = true, code = code, reason = reason)
    }

    private fun removeCircuit(
        circuitId: Long,
        notify: Boolean,
        code: Int,
        reason: String,
    ) {
        val removed = synchronized(lock) {
            pending.remove(circuitId)?.also { it.timeout.cancel() }?.circuit
                ?: circuits.remove(circuitId)
        }
        synchronized(lock) {
            removeQueuedFramesLocked(circuitId)
            scheduleIdleCloseLocked()
        }
        if (notify) removed?.closed(code, reason)
    }

    private fun terminate(error: Throwable?, code: Int, reason: String) {
        val affected = synchronized(lock) {
            if (terminated) return
            terminated = true
            closing = true
            readyTimeout?.cancel()
            idleClose?.cancel()
            drainJob?.cancel()
            if (!ready.isCompleted) {
                ready.completeExceptionally(error ?: IllegalStateException(reason))
            }
            val result = pending.values.map { it.circuit } + circuits.values
            pending.values.forEach { it.timeout.cancel() }
            pending.clear()
            circuits.clear()
            queues.clear()
            queuedBytesByCircuit.clear()
            circuitOrder.clear()
            queuedBytes = 0
            result
        }
        affected.forEach { circuit ->
            if (error != null) circuit.failed(error) else circuit.closed(code, reason)
        }
        onTerminated()
    }

    private fun protocolError(reason: String) {
        if (!ready.isCompleted) ready.completeExceptionally(IllegalStateException(reason))
        close(1008, reason)
    }

    private fun sendControl(message: JSONObject): Boolean {
        val owned = synchronized(lock) {
            if (terminated || closing) null else socket
        }
        return owned?.send(message.toString()) == true
    }

    private fun allocateCircuitIdLocked(): Long {
        repeat(MAX_CIRCUIT_ALLOCATION_ATTEMPTS) {
            val candidate = nextCircuitId
            nextCircuitId = if (candidate == MAX_CIRCUIT_ID) 1 else candidate + 1
            if (!pending.containsKey(candidate) && !circuits.containsKey(candidate)) {
                return candidate
            }
        }
        throw IllegalStateException("Relay mux circuit ids exhausted")
    }

    private fun ensureDrainLocked() {
        if (drainJob?.isActive == true) return
        drainJob = scope.launch {
            while (true) {
                val next = synchronized(lock) {
                    if (terminated || closing || queuedBytes == 0L) {
                        drainJob = null
                        return@launch
                    }
                    if ((socket?.queueSize() ?: 0L) > CLIENT_BUFFERED_AMOUNT_HIGH_WATER) {
                        null
                    } else {
                        nextQueuedFrameLocked()
                    }
                }
                if (next == null) {
                    delay(DRAIN_RETRY_MS)
                } else if (synchronized(lock) { socket }?.send(next.bytes) != true) {
                    protocolError("Relay mux disconnected while sending")
                    return@launch
                }
            }
        }
    }

    private fun nextQueuedFrameLocked(): QueuedFrame? {
        if (circuitOrder.isEmpty()) return null
        repeat(circuitOrder.size) { offset ->
            val index = (drainCursor + offset) % circuitOrder.size
            val circuitId = circuitOrder[index]
            val queue = queues[circuitId] ?: return@repeat
            val frame = queue.pollFirst() ?: return@repeat
            drainCursor = (index + 1) % circuitOrder.size
            queuedBytes -= frame.bytes.size
            queuedBytesByCircuit[circuitId] =
                (queuedBytesByCircuit[circuitId] ?: frame.bytes.size.toLong()) - frame.bytes.size
            if (queue.isEmpty()) {
                queues.remove(circuitId)
                circuitOrder.removeAt(index)
                if (circuitOrder.isEmpty()) {
                    drainCursor = 0
                } else if (drainCursor >= circuitOrder.size) {
                    drainCursor %= circuitOrder.size
                }
            }
            return frame
        }
        return null
    }

    private fun removeQueuedFramesLocked(circuitId: Long) {
        queuedBytes -= queuedBytesByCircuit.remove(circuitId) ?: 0L
        queues.remove(circuitId)
        val index = circuitOrder.indexOf(circuitId)
        if (index >= 0) circuitOrder.removeAt(index)
        if (circuitOrder.isEmpty()) drainCursor = 0 else drainCursor %= circuitOrder.size
    }

    private fun scheduleIdleCloseLocked() {
        if (pending.isNotEmpty() || circuits.isNotEmpty() || terminated || closing) return
        if (idleClose?.isActive == true) return
        idleClose = scope.launch {
            delay(MUX_IDLE_CLOSE_DELAY_MS)
            close(1000, "Relay mux idle")
        }
    }
}

private class RelayMuxCircuitSocket(
    private val physical: RelayMuxPhysicalConnection,
    private val circuitId: Long,
    private val wrapper: DeferredClientSocket,
    private val listener: YaClientSocketListener,
) : YaClientSocket {
    private val lock = Any()
    private var state = CircuitState.CONNECTING

    fun opened() {
        val notify = synchronized(lock) {
            if (state != CircuitState.CONNECTING) false else {
                state = CircuitState.OPEN
                true
            }
        }
        if (notify && !wrapper.isTerminal()) listener.onOpen(wrapper, relayPaired = true)
    }

    fun receive(payload: ByteString, isBinary: Boolean) {
        if (synchronized(lock) { state != CircuitState.OPEN } || wrapper.isTerminal()) return
        if (isBinary) listener.onBytes(wrapper, payload) else listener.onText(wrapper, payload.utf8())
    }

    fun failed(error: Throwable) {
        synchronized(lock) { state = CircuitState.CLOSED }
        wrapper.fail(error)
    }

    fun closed(code: Int, reason: String) {
        synchronized(lock) { state = CircuitState.CLOSED }
        wrapper.closed(code, reason)
    }

    fun markClosing(): Boolean = synchronized(lock) {
        if (state == CircuitState.CLOSING || state == CircuitState.CLOSED) return false
        state = CircuitState.CLOSING
        true
    }

    override fun queueSize(): Long = physical.queueSize(circuitId)

    override fun send(text: String): Boolean = synchronized(lock) {
        state == CircuitState.OPEN && physical.enqueue(circuitId, text.encodeUtf8(), isBinary = false)
    }

    override fun send(bytes: ByteString): Boolean = synchronized(lock) {
        state == CircuitState.OPEN && physical.enqueue(circuitId, bytes, isBinary = true)
    }

    override fun close(code: Int, reason: String): Boolean =
        physical.requestCircuitClose(circuitId, code, reason)

    override fun cancel() {
        synchronized(lock) { state = CircuitState.CLOSED }
        physical.cancelCircuit(circuitId)
    }
}

internal data class RelayMuxDecodedFrame(
    val circuitId: Long,
    val isBinary: Boolean,
    val payload: ByteString,
)

internal fun encodeRelayMuxFrame(
    circuitId: Long,
    payload: ByteString,
    isBinary: Boolean,
): ByteString {
    require(circuitId in 1..MAX_CIRCUIT_ID) { "Invalid relay mux circuit id" }
    val header = ByteArray(MUX_HEADER_BYTES)
    header[0] = MUX_PROTOCOL_VERSION.toByte()
    header[1] = if (isBinary) MUX_BINARY_FLAG.toByte() else 0
    header[2] = (circuitId ushr 24).toByte()
    header[3] = (circuitId ushr 16).toByte()
    header[4] = (circuitId ushr 8).toByte()
    header[5] = circuitId.toByte()
    return Buffer().write(header).write(payload).readByteString()
}

internal fun decodeRelayMuxFrame(bytes: ByteString): RelayMuxDecodedFrame {
    require(bytes.size >= MUX_HEADER_BYTES) { "Relay mux data frame is too short" }
    val version = bytes[0].toInt() and 0xff
    val flags = bytes[1].toInt() and 0xff
    val circuitId =
        ((bytes[2].toLong() and 0xff) shl 24) or
            ((bytes[3].toLong() and 0xff) shl 16) or
            ((bytes[4].toLong() and 0xff) shl 8) or
            (bytes[5].toLong() and 0xff)
    require(version == MUX_PROTOCOL_VERSION) { "Unsupported relay mux frame version" }
    require(flags and MUX_BINARY_FLAG.inv() == 0) { "Invalid relay mux frame flags" }
    require(circuitId in 1..MAX_CIRCUIT_ID) { "Invalid relay mux circuit id" }
    return RelayMuxDecodedFrame(
        circuitId = circuitId,
        isBinary = flags and MUX_BINARY_FLAG != 0,
        payload = bytes.substring(MUX_HEADER_BYTES),
    )
}

internal class RelayMuxCircuitOpenException(reason: String) : IllegalStateException(reason)

private fun isValidCircuitId(circuitId: Long): Boolean = circuitId in 1..MAX_CIRCUIT_ID

private data class PendingCircuit(
    val circuit: RelayMuxCircuitSocket,
    val timeout: Job,
)

private data class QueuedFrame(val bytes: ByteString)

private enum class CircuitState {
    CONNECTING,
    OPEN,
    CLOSING,
    CLOSED,
}

private const val RELAY_CLIENT_MUX_V1_CAPABILITY = "client-mux-v1"
private const val MUX_PROTOCOL_VERSION = 1
private const val MUX_HEADER_BYTES = 6
private const val MUX_BINARY_FLAG = 1
private const val DISCOVERY_TIMEOUT_MS = 2_000L
private const val MUX_READY_TIMEOUT_MS = 5_000L
private const val MUX_OPEN_TIMEOUT_MS = 30_000L
private const val CIRCUIT_CLOSE_TIMEOUT_MS = 5_000L
private const val MUX_IDLE_CLOSE_DELAY_MS = 5_000L
private const val MAX_HEALTH_RESPONSE_BYTES = 64 * 1024
private const val CLIENT_QUEUE_BYTES_PER_CIRCUIT = 2L * 1024 * 1024
private const val CLIENT_QUEUE_BYTES_PER_SOCKET = 8L * 1024 * 1024
private const val CLIENT_BUFFERED_AMOUNT_HIGH_WATER = 1024L * 1024
private const val DRAIN_RETRY_MS = 10L
private const val MAX_CIRCUIT_ID = 0xffff_ffffL
private const val MAX_CIRCUIT_ALLOCATION_ATTEMPTS = 65_536
private val MUX_ERROR_REASONS = setOf(
    "unknown_username",
    "server_offline",
    "circuit_limit",
    "rate_limited",
    "invalid_request",
)
private val MUX_CLOSED_REASONS = setOf("client_closed", "server_closed", "relay_closed")
