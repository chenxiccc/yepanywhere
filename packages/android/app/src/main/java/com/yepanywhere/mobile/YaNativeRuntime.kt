package com.yepanywhere.mobile

import android.content.Context
import com.yepanywhere.mobile.connection.YaNativeProfileConnector
import com.yepanywhere.mobile.connection.YaNativeSecureConnection
import com.yepanywhere.mobile.connection.YaPairingCoordinator
import com.yepanywhere.mobile.connection.YaServerConnectionManager
import com.yepanywhere.mobile.profiles.YaPairedServerStore
import java.io.Closeable
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient

class YaNativeRuntime(context: Context) : Closeable {
    val pairedServers = YaPairedServerStore.create(context)
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()
    private val connector = YaNativeProfileConnector(
        YaNativeSecureConnection(httpClient),
    )
    val pairing = YaPairingCoordinator(pairedServers, connector)
    private val connectionManagers = mutableMapOf<String, YaServerConnectionManager>()

    @Synchronized
    fun connectionManager(profileId: String): YaServerConnectionManager {
        return connectionManagers.getOrPut(profileId) {
            YaServerConnectionManager(
                profileId = profileId,
                repository = pairedServers,
                connector = connector,
            )
        }
    }

    override fun close() {
        val managers = synchronized(this) {
            connectionManagers.values.toList().also { connectionManagers.clear() }
        }
        managers.forEach { it.close() }
        pairedServers.close()
        httpClient.connectionPool.evictAll()
        httpClient.dispatcher.executorService.shutdown()
    }
}
