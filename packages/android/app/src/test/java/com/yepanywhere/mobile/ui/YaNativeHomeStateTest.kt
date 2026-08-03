package com.yepanywhere.mobile.ui

import com.yepanywhere.mobile.profiles.YaPairedServerProfile
import com.yepanywhere.mobile.profiles.YaServerRoute
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class YaNativeHomeStateTest {
    @Test
    fun `all servers keeps colliding YA session ids source scoped`() {
        val alpha = profile("alpha")
        val beta = profile("beta")
        val sharedId = "same-session-id"
        val state = YaNativeHomeState(
            profiles = listOf(alpha, beta),
            includedProfileIds = setOf(alpha.id, beta.id),
            servers = mapOf(
                alpha.id to source(alpha, sharedId, "2026-08-03T08:00:00.000Z", "🟢"),
                beta.id to source(beta, sharedId, "2026-08-03T09:00:00.000Z", null),
            ),
        )

        assertEquals(listOf("beta", "alpha"), state.sourcedSessions.map { it.serverUsername })
        assertEquals(2, state.sourcedSessions.map(YaSourcedSession::key).toSet().size)
        assertTrue(state.sourcedSessions.all { it.session.id == sharedId })
    }

    @Test
    fun `server filter projects data without changing inclusion`() {
        val alpha = profile("alpha")
        val beta = profile("beta")
        val state = YaNativeHomeState(
            profiles = listOf(alpha, beta),
            includedProfileIds = setOf(alpha.id, beta.id),
            filterProfileId = alpha.id,
            servers = mapOf(
                alpha.id to source(alpha, "a", "2026-08-03T08:00:00.000Z", null),
                beta.id to source(beta, "b", "2026-08-03T09:00:00.000Z", null),
            ),
        )

        assertEquals(setOf(alpha.id, beta.id), state.includedProfileIds)
        assertEquals(listOf(alpha.id), state.sourcedSessions.map(YaSourcedSession::profileId))
    }

    private fun source(
        profile: YaPairedServerProfile,
        sessionId: String,
        updatedAt: String,
        icon: String?,
    ): YaNativeServerState = YaNativeServerState(
        profile = profile,
        included = true,
        sessions = listOf(
            YaSessionSummary(
                id = sessionId,
                title = "Session",
                projectName = "Project",
                provider = "codex",
                updatedAt = updatedAt,
                pendingInputType = null,
                activity = null,
                hasUnread = false,
                lastAgentText = null,
            ),
        ),
        hostIcon = icon,
    )

    private fun profile(username: String): YaPairedServerProfile = YaPairedServerProfile.create(
        label = username,
        username = username,
        route = YaServerRoute.relay("wss://relay.example/ws", "$username-server"),
        nowEpochMs = 1_000,
    )
}
