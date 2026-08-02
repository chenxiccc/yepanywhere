package com.yepanywhere.mobile.connection

import com.yepanywhere.mobile.profiles.YaPairedServerProfile
import com.yepanywhere.mobile.profiles.YaPairedServerRepository
import com.yepanywhere.mobile.profiles.YaServerRoute
import com.yepanywhere.mobile.profiles.YaStoredResumeCredential

class YaPairingCoordinator(
    private val repository: YaPairedServerRepository,
    private val connector: YaProfileConnector,
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
            val profile = YaPairedServerProfile.create(
                label = label,
                username = username,
                route = route,
                nowEpochMs = establishedAt,
            ).copy(lastConnectedAtEpochMs = establishedAt)
            repository.upsert(
                profile = profile,
                resumeCredential = YaStoredResumeCredential(
                    credential = transport.credential,
                    establishedAtEpochMs = establishedAt,
                    lastResumedAtEpochMs = null,
                ),
                select = true,
            )
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
