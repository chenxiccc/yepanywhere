package com.yepanywhere.mobile.connection

import com.yepanywhere.mobile.profiles.YaPairedServerProfile
import com.yepanywhere.mobile.profiles.YaServerRoute
import com.yepanywhere.mobile.profiles.YaServerRouteKind
import kotlinx.coroutines.CancellationException
import org.json.JSONObject

interface YaMessageTransport {
    val credential: YaResumeCredential
    val resumed: Boolean
    val securityBinding: YaSrpTransportBinding?
        get() = null

    fun send(message: JSONObject)
    suspend fun receive(): JSONObject
    suspend fun awaitClosed()
    suspend fun closeAndAwait()
    fun cancel()
}

enum class YaSrpAuthenticationMethod {
    FULL,
    RESUME,
}

data class YaSrpTransportBinding(
    val sessionId: String,
    val transportNonce: String,
    val authenticationMethod: YaSrpAuthenticationMethod,
) {
    init {
        require(sessionId.isNotBlank())
        require(transportNonce.isNotBlank())
    }
}

interface YaSecureSessionOpener {
    suspend fun login(
        wsUrl: String,
        username: String,
        password: String,
        relayTarget: String? = null,
    ): YaMessageTransport

    suspend fun resume(
        wsUrl: String,
        credential: YaResumeCredential,
        relayTarget: String? = null,
    ): YaMessageTransport
}

data class YaRoutedTransport(
    val route: YaServerRoute,
    val transport: YaMessageTransport,
)

interface YaProfileConnector {
    suspend fun resume(
        profile: YaPairedServerProfile,
        credential: YaResumeCredential,
    ): YaRoutedTransport

    suspend fun login(
        route: YaServerRoute,
        username: String,
        password: String,
    ): YaMessageTransport
}

class YaAllRoutesRejectedException :
    IllegalStateException("Every reachable route rejected the resume credential")

class YaNoRouteConnectedException(causes: List<Throwable>) :
    IllegalStateException(
        "Could not connect through any saved server route",
        causes.firstOrNull(),
    )

class YaNativeProfileConnector(
    private val connection: YaSecureSessionOpener,
) : YaProfileConnector {
    override suspend fun resume(
        profile: YaPairedServerProfile,
        credential: YaResumeCredential,
    ): YaRoutedTransport {
        val routes = profile.routes.sortedWith(
            compareByDescending<YaServerRoute> { it.id == profile.preferredRouteId }
                .thenBy { it.kind != YaServerRouteKind.DIRECT },
        )
        val failures = mutableListOf<Throwable>()
        var rejectedRoutes = 0
        for (route in routes) {
            try {
                return YaRoutedTransport(
                    route = route,
                    transport = connection.resume(
                        wsUrl = route.websocketUrl,
                        credential = credential,
                        relayTarget = route.relayTarget,
                    ),
                )
            } catch (error: YaResumeRejectedException) {
                rejectedRoutes += 1
                failures += error
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                failures += error
            }
        }
        if (rejectedRoutes == routes.size) throw YaAllRoutesRejectedException()
        throw YaNoRouteConnectedException(failures)
    }

    override suspend fun login(
        route: YaServerRoute,
        username: String,
        password: String,
    ): YaMessageTransport {
        return connection.login(
            wsUrl = route.websocketUrl,
            username = username,
            password = password,
            relayTarget = route.relayTarget,
        )
    }
}
