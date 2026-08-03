package com.yepanywhere.mobile.profiles

import kotlinx.coroutines.CancellationException

internal enum class YaServerRemovalOutcome {
    COMPLETE,
    NEEDS_FORGET_ANYWAY,
    NEEDS_LOCAL_CLEANUP,
}

/** Coordinates server revocation before destructive phone-local cleanup. */
internal class YaServerRemovalCoordinator(
    private val forget: suspend (String) -> Unit,
) {
    suspend fun remove(
        profile: YaPairedServerProfile,
        unregister: (suspend (clientId: String) -> Unit)?,
    ): YaServerRemovalOutcome {
        val clientId = profile.securityClient
            ?.takeIf { !it.revoked && !it.capabilityMissing }
            ?.clientId
        if (clientId == null) {
            return forgetLocally(profile.id, serverWasUnregistered = false)
        }
        if (unregister == null) return YaServerRemovalOutcome.NEEDS_FORGET_ANYWAY
        try {
            unregister(clientId)
        } catch (error: CancellationException) {
            throw error
        } catch (_: Throwable) {
            return YaServerRemovalOutcome.NEEDS_FORGET_ANYWAY
        }
        return forgetLocally(profile.id, serverWasUnregistered = true)
    }

    suspend fun forgetAnyway(profileId: String): YaServerRemovalOutcome {
        return forgetLocally(profileId, serverWasUnregistered = false)
    }

    private suspend fun forgetLocally(
        profileId: String,
        serverWasUnregistered: Boolean,
    ): YaServerRemovalOutcome {
        return try {
            forget(profileId)
            YaServerRemovalOutcome.COMPLETE
        } catch (error: CancellationException) {
            throw error
        } catch (_: Throwable) {
            if (serverWasUnregistered) {
                YaServerRemovalOutcome.NEEDS_LOCAL_CLEANUP
            } else {
                YaServerRemovalOutcome.NEEDS_FORGET_ANYWAY
            }
        }
    }
}
