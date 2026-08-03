package com.yepanywhere.mobile.connection

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString

interface YaClientSocket {
    fun queueSize(): Long
    fun send(text: String): Boolean
    fun send(bytes: ByteString): Boolean
    fun close(code: Int, reason: String): Boolean
    fun cancel()
}

interface YaClientSocketListener {
    /**
     * `relayPaired` is true for direct sockets and mux circuits. A legacy relay
     * `/ws` socket still needs the plaintext `client_connect` exchange.
     */
    fun onOpen(socket: YaClientSocket, relayPaired: Boolean)
    fun onText(socket: YaClientSocket, text: String)
    fun onBytes(socket: YaClientSocket, bytes: ByteString)
    fun onClosing(socket: YaClientSocket, code: Int, reason: String)
    fun onClosed(socket: YaClientSocket, code: Int, reason: String)
    fun onFailure(socket: YaClientSocket, error: Throwable)
}

interface YaClientSocketConnector {
    fun open(
        websocketUrl: String,
        relayTarget: String?,
        listener: YaClientSocketListener,
    ): YaClientSocket
}

class YaOkHttpClientSocketConnector(
    private val httpClient: OkHttpClient,
) : YaClientSocketConnector {
    override fun open(
        websocketUrl: String,
        relayTarget: String?,
        listener: YaClientSocketListener,
    ): YaClientSocket {
        lateinit var adapter: OkHttpClientSocket
        val webSocket = httpClient.newWebSocket(
            Request.Builder().url(websocketUrl).build(),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    listener.onOpen(adapter, relayPaired = relayTarget == null)
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    listener.onText(adapter, text)
                }

                override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                    listener.onBytes(adapter, bytes)
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    listener.onClosing(adapter, code, reason)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    listener.onClosed(adapter, code, reason)
                }

                override fun onFailure(
                    webSocket: WebSocket,
                    t: Throwable,
                    response: Response?,
                ) {
                    listener.onFailure(adapter, t)
                }
            },
        )
        adapter = OkHttpClientSocket(webSocket)
        return adapter
    }

    private class OkHttpClientSocket(
        private val socket: WebSocket,
    ) : YaClientSocket {
        override fun queueSize(): Long = socket.queueSize()
        override fun send(text: String): Boolean = socket.send(text)
        override fun send(bytes: ByteString): Boolean = socket.send(bytes)
        override fun close(code: Int, reason: String): Boolean = socket.close(code, reason)
        override fun cancel() = socket.cancel()
    }
}
