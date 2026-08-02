package com.yepanywhere.mobile.profiles

import com.yepanywhere.mobile.connection.YaResumeCredential
import java.net.URI
import java.util.UUID

enum class YaServerRouteKind {
    DIRECT,
    RELAY,
}

data class YaServerRoute(
    val id: String,
    val kind: YaServerRouteKind,
    val websocketUrl: String,
    val relayTarget: String? = null,
) {
    init {
        requireUuid(id, "route id")
        val uri = URI(websocketUrl)
        require(uri.scheme == "ws" || uri.scheme == "wss") {
            "Server route must use ws or wss"
        }
        require(uri.host != null && uri.userInfo == null && uri.fragment == null) {
            "Server route must have a host and no user information or fragment"
        }
        when (kind) {
            YaServerRouteKind.DIRECT -> require(relayTarget == null)
            YaServerRouteKind.RELAY -> require(
                !relayTarget.isNullOrBlank() && relayTarget.length <= MAX_RELAY_TARGET_LENGTH,
            )
        }
    }

    companion object {
        private const val MAX_RELAY_TARGET_LENGTH = 128

        fun direct(websocketUrl: String): YaServerRoute {
            return YaServerRoute(
                id = UUID.randomUUID().toString(),
                kind = YaServerRouteKind.DIRECT,
                websocketUrl = websocketUrl,
            )
        }

        fun relay(websocketUrl: String, relayTarget: String): YaServerRoute {
            return YaServerRoute(
                id = UUID.randomUUID().toString(),
                kind = YaServerRouteKind.RELAY,
                websocketUrl = websocketUrl,
                relayTarget = relayTarget,
            )
        }
    }
}

data class YaPairedServerProfile(
    val id: String,
    val label: String,
    val username: String,
    val routes: List<YaServerRoute>,
    val preferredRouteId: String?,
    val createdAtEpochMs: Long,
    val lastConnectedAtEpochMs: Long?,
) {
    init {
        requireUuid(id, "profile id")
        require(label.isNotBlank() && label.length <= MAX_LABEL_LENGTH)
        require(username.isNotBlank() && username.length <= MAX_USERNAME_LENGTH)
        require(routes.isNotEmpty())
        require(routes.map(YaServerRoute::id).toSet().size == routes.size)
        require(preferredRouteId == null || routes.any { it.id == preferredRouteId })
        require(createdAtEpochMs >= 0)
        require(lastConnectedAtEpochMs == null || lastConnectedAtEpochMs >= 0)
    }

    companion object {
        private const val MAX_LABEL_LENGTH = 80
        private const val MAX_USERNAME_LENGTH = 128

        fun create(
            label: String,
            username: String,
            route: YaServerRoute,
            nowEpochMs: Long = System.currentTimeMillis(),
        ): YaPairedServerProfile {
            return YaPairedServerProfile(
                id = UUID.randomUUID().toString(),
                label = label,
                username = username,
                routes = listOf(route),
                preferredRouteId = route.id,
                createdAtEpochMs = nowEpochMs,
                lastConnectedAtEpochMs = null,
            )
        }
    }
}

data class YaStoredResumeCredential(
    val credential: YaResumeCredential,
    val establishedAtEpochMs: Long,
    val lastResumedAtEpochMs: Long?,
) {
    init {
        require(establishedAtEpochMs >= 0)
        require(lastResumedAtEpochMs == null || lastResumedAtEpochMs >= establishedAtEpochMs)
    }

    /**
     * Mirrors the server's current conservative resume limits so Android can
     * ask for a password without first attempting a credential known to be
     * stale. The server remains authoritative and may reject sooner.
     */
    fun isEligibleAt(nowEpochMs: Long): Boolean {
        require(nowEpochMs >= 0)
        val lastUsedAtEpochMs = lastResumedAtEpochMs ?: establishedAtEpochMs
        return elapsedSince(establishedAtEpochMs, nowEpochMs) <= MAX_LIFETIME_MS &&
            elapsedSince(lastUsedAtEpochMs, nowEpochMs) <= IDLE_TIMEOUT_MS
    }

    companion object {
        const val IDLE_TIMEOUT_MS = 7L * 24 * 60 * 60 * 1000
        const val MAX_LIFETIME_MS = 30L * 24 * 60 * 60 * 1000

        private fun elapsedSince(earlierEpochMs: Long, nowEpochMs: Long): Long {
            return if (nowEpochMs >= earlierEpochMs) nowEpochMs - earlierEpochMs else 0
        }
    }
}

data class YaPairedServerSnapshot(
    val profile: YaPairedServerProfile,
    val resumeCredential: YaStoredResumeCredential?,
)

internal fun requireUuid(value: String, name: String) {
    require(runCatching { UUID.fromString(value).toString() == value }.getOrDefault(false)) {
        "$name must be a canonical UUID"
    }
}
