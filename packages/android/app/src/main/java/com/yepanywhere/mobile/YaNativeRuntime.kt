package com.yepanywhere.mobile

import android.content.Context
import com.yepanywhere.mobile.connection.YaNativeProfileConnector
import com.yepanywhere.mobile.connection.YaNativeSecureConnection
import com.yepanywhere.mobile.connection.YaOkHttpClientSocketConnector
import com.yepanywhere.mobile.connection.YaPairingCoordinator
import com.yepanywhere.mobile.connection.YaRelayMuxSocketBroker
import com.yepanywhere.mobile.connection.YaServerConnectionManager
import com.yepanywhere.mobile.profiles.YaPairedServerStore
import com.yepanywhere.mobile.security.AndroidKeystoreSecurityClientKeyStore
import com.yepanywhere.mobile.security.YaAndroidSecurityClientDescriptorProvider
import com.yepanywhere.mobile.security.YaSecurityClientCoordinator
import java.io.Closeable
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient

class YaNativeRuntime(context: Context) : Closeable {
    private val securityKeys = AndroidKeystoreSecurityClientKeyStore()
    val pairedServers = YaPairedServerStore.create(context, securityKeys = securityKeys)
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()
    private val relayMuxSockets = YaRelayMuxSocketBroker(
        httpClient = httpClient,
        legacyConnector = YaOkHttpClientSocketConnector(httpClient),
    )
    private val connector = YaNativeProfileConnector(
        YaNativeSecureConnection(
            httpClient = httpClient,
            socketConnector = relayMuxSockets,
        ),
    )
    private val securityClients = YaSecurityClientCoordinator(
        repository = pairedServers,
        keys = securityKeys,
        descriptors = YaAndroidSecurityClientDescriptorProvider(context),
    )
    val pairing = YaPairingCoordinator(pairedServers, connector, securityClients)
    private val connectionManagers = mutableMapOf<String, YaServerConnectionManager>()

    @Synchronized
    fun connectionManager(profileId: String): YaServerConnectionManager {
        return connectionManagers.getOrPut(profileId) {
            YaServerConnectionManager(
                profileId = profileId,
                repository = pairedServers,
                connector = connector,
                securityClients = securityClients,
            )
        }
    }

    override fun close() {
        val managers = synchronized(this) {
            connectionManagers.values.toList().also { connectionManagers.clear() }
        }
        managers.forEach { it.close() }
        relayMuxSockets.close()
        pairedServers.close()
        httpClient.connectionPool.evictAll()
        httpClient.dispatcher.executorService.shutdown()
    }
}
