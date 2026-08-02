package com.yepanywhere.mobile.connection

import com.yepanywhere.mobile.profiles.YaPairedServerProfile
import com.yepanywhere.mobile.profiles.YaPairedServerRepository
import com.yepanywhere.mobile.profiles.YaServerRoute
import com.yepanywhere.mobile.profiles.YaStoredResumeCredential
import com.yepanywhere.mobile.profiles.YaSecurityClientBinding
import com.yepanywhere.mobile.security.YaSecurityClientLifecycle
import com.yepanywhere.mobile.security.YaSecurityClientProtocol
import com.yepanywhere.mobile.security.YaSecurityClientRevokedException

class YaPairingCoordinator(
    private val repository: YaPairedServerRepository,
    private val connector: YaProfileConnector,
    private val securityClients: YaSecurityClientLifecycle? = null,
    private val nowEpochMs: () -> Long = System::currentTimeMillis,
) {
    suspend fun pair(
        label: String,
        username: String,
        password: String,
        route: YaServerRoute,
    ): YaPairedServerProfile {
        val transport = connector.login(route, username, password)
        try {
            val establishedAt = nowEpochMs()
            var profile = YaPairedServerProfile.create(
                label = label,
                username = username,
                route = route,
                nowEpochMs = establishedAt,
            ).copy(lastConnectedAtEpochMs = establishedAt)
            if (securityClients != null) {
                profile = profile.copy(
                    securityClient = YaSecurityClientBinding.pending(
                        YaSecurityClientProtocol.keyAlias(profile.id),
                    ),
                )
            }
            repository.upsert(
                profile = profile,
                resumeCredential = YaStoredResumeCredential(
                    credential = transport.credential,
                    establishedAtEpochMs = establishedAt,
                    lastResumedAtEpochMs = null,
                ),
                select = true,
            )
            if (securityClients != null) {
                profile = securityClients.ensure(profile, transport)
            }
            return profile
        } finally {
            transport.closeAndAwait()
        }
    }

    suspend fun reauthenticate(
        profileId: String,
        password: String,
        routeId: String? = null,
    ) {
        val snapshot = checkNotNull(repository.snapshot(profileId)) {
            "Cannot authenticate a removed paired server"
        }
        snapshot.profile.securityClient?.takeIf { it.revoked }?.let {
            throw YaSecurityClientRevokedException(checkNotNull(it.clientId))
        }
        val route = if (routeId == null) {
            snapshot.profile.routes.firstOrNull {
                it.id == snapshot.profile.preferredRouteId
            } ?: snapshot.profile.routes.first()
        } else {
            snapshot.profile.routes.firstOrNull { it.id == routeId }
                ?: error("Cannot authenticate through an unknown route")
        }
        val transport = connector.login(
            route = route,
            username = snapshot.profile.username,
            password = password,
        )
        try {
            securityClients?.ensure(snapshot.profile, transport)
            val establishedAt = nowEpochMs()
            repository.recordSuccessfulAuthentication(
                profileId = profileId,
                routeId = route.id,
                resumeCredential = YaStoredResumeCredential(
                    credential = transport.credential,
                    establishedAtEpochMs = establishedAt,
                    lastResumedAtEpochMs = null,
                ),
                connectedAtEpochMs = establishedAt,
            )
        } finally {
            transport.closeAndAwait()
        }
    }
}
