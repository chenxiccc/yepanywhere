package com.yepanywhere.mobile.profiles

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class YaServerRemovalCoordinatorTest {
    @Test
    fun `registered online device unregisters before local forget`() =
        kotlinx.coroutines.runBlocking {
            val events = mutableListOf<String>()
            val profile = profile(registered = true)
            val coordinator = YaServerRemovalCoordinator { events += "forget:$it" }

            val outcome = coordinator.remove(profile) { clientId ->
                events += "unregister:$clientId"
            }

            assertEquals(YaServerRemovalOutcome.COMPLETE, outcome)
            assertEquals(
                listOf(
                    "unregister:${profile.securityClient?.clientId}",
                    "forget:${profile.id}",
                ),
                events,
            )
        }

    @Test
    fun `registered offline device requires explicit forget anyway`() =
        kotlinx.coroutines.runBlocking {
            var forgot = false
            val coordinator = YaServerRemovalCoordinator { forgot = true }

            val outcome = coordinator.remove(profile(registered = true), unregister = null)

            assertEquals(YaServerRemovalOutcome.NEEDS_FORGET_ANYWAY, outcome)
            assertTrue(!forgot)
        }

    @Test
    fun `unregister failure preserves local state`() = kotlinx.coroutines.runBlocking {
        var forgot = false
        val coordinator = YaServerRemovalCoordinator { forgot = true }

        val outcome = coordinator.remove(profile(registered = true)) {
            error("server unavailable")
        }

        assertEquals(YaServerRemovalOutcome.NEEDS_FORGET_ANYWAY, outcome)
        assertTrue(!forgot)
    }

    @Test
    fun `legacy profile performs honest local-only forget`() = kotlinx.coroutines.runBlocking {
        var forgot = false
        val coordinator = YaServerRemovalCoordinator { forgot = true }

        val outcome = coordinator.remove(profile(registered = false)) {
            error("must not unregister")
        }

        assertEquals(YaServerRemovalOutcome.COMPLETE, outcome)
        assertTrue(forgot)
    }

    @Test
    fun `successful unregister distinguishes a local cleanup failure`() =
        kotlinx.coroutines.runBlocking {
            val coordinator = YaServerRemovalCoordinator { error("storage failed") }

            val outcome = coordinator.remove(profile(registered = true)) { }

            assertEquals(YaServerRemovalOutcome.NEEDS_LOCAL_CLEANUP, outcome)
        }

    private fun profile(registered: Boolean): YaPairedServerProfile {
        val profile = YaPairedServerProfile.create(
            label = "alpha",
            username = "alpha",
            route = YaServerRoute.relay("wss://relay.example/ws", "alpha-server"),
            nowEpochMs = 1_000,
        )
        return if (registered) {
            profile.copy(
                securityClient = YaSecurityClientBinding.registered(
                    keyAlias = "ya_security_client_p256_v1_alpha",
                    clientId = "22222222-2222-4222-8222-222222222222",
                ),
            )
        } else {
            profile
        }
    }
}
