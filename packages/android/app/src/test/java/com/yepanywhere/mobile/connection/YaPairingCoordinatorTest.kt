package com.yepanywhere.mobile.connection

import com.yepanywhere.mobile.profiles.YaPairedServerProfile
import com.yepanywhere.mobile.profiles.YaPairedServerRepository
import com.yepanywhere.mobile.profiles.YaPairedServerSnapshot
import com.yepanywhere.mobile.profiles.YaServerRoute
import com.yepanywhere.mobile.profiles.YaStoredResumeCredential
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class YaPairingCoordinatorTest {
    @Test
    fun reauthenticatesThroughThePreferredRouteAndReplacesTheCredential() = runBlocking {
        val direct = YaServerRoute.direct("wss://computer.example.test/api/ws")
        val relay = YaServerRoute.relay(
            websocketUrl = "wss://relay.example.test/ws",
            relayTarget = "remote-target",
        )
        val profile = YaPairedServerProfile.create(
            label = "Studio",
            username = "remote-user",
            route = direct,
            nowEpochMs = 1_000,
        ).copy(
            routes = listOf(direct, relay),
            preferredRouteId = relay.id,
        )
        val repository = FakeRepository(YaPairedServerSnapshot(profile, null))
        val transport = FakeTransport(
            YaResumeCredential(
                username = profile.username,
                sessionId = "new-session",
                baseKey = ByteArray(YaSecureTransportCrypto.KEY_BYTES) { it.toByte() },
                resumeProtocolVersion = YaSecureTransportCrypto.RESUME_PROTOCOL_VERSION,
            ),
        )
        val connector = FakeConnector(transport)
        val coordinator = YaPairingCoordinator(repository, connector) { 2_000 }

        coordinator.reauthenticate(profile.id, "one-time-password")

        assertEquals(relay, connector.loginRoute)
        assertEquals(profile.username, connector.loginUsername)
        assertEquals("one-time-password", connector.loginPassword)
        assertTrue(transport.closed)
        val stored = checkNotNull(repository.value.resumeCredential)
        assertEquals("new-session", stored.credential.sessionId)
        assertEquals(2_000L, stored.establishedAtEpochMs)
        assertNull(stored.lastResumedAtEpochMs)
        assertEquals(relay.id, repository.value.profile.preferredRouteId)
        assertEquals(2_000L, repository.value.profile.lastConnectedAtEpochMs)
    }

    private class FakeRepository(
        var value: YaPairedServerSnapshot,
    ) : YaPairedServerRepository {
        override suspend fun snapshot(profileId: String): YaPairedServerSnapshot? {
            return value.takeIf { it.profile.id == profileId }
        }

        override suspend fun upsert(
            profile: YaPairedServerProfile,
            resumeCredential: YaStoredResumeCredential?,
            select: Boolean,
        ) {
            value = YaPairedServerSnapshot(profile, resumeCredential)
        }

        override suspend fun clearCredential(profileId: String) {
            value = value.copy(resumeCredential = null)
        }

        override suspend fun recordSuccessfulAuthentication(
            profileId: String,
            routeId: String,
            resumeCredential: YaStoredResumeCredential,
            connectedAtEpochMs: Long,
        ) {
            value = value.copy(
                profile = value.profile.copy(
                    preferredRouteId = routeId,
                    lastConnectedAtEpochMs = connectedAtEpochMs,
                ),
                resumeCredential = resumeCredential,
            )
        }
    }

    private class FakeConnector(
        private val transport: YaMessageTransport,
    ) : YaProfileConnector {
        var loginRoute: YaServerRoute? = null
        var loginUsername: String? = null
        var loginPassword: String? = null

        override suspend fun resume(
            profile: YaPairedServerProfile,
            credential: YaResumeCredential,
        ): YaRoutedTransport = error("Not used")

        override suspend fun login(
            route: YaServerRoute,
            username: String,
            password: String,
        ): YaMessageTransport {
            loginRoute = route
            loginUsername = username
            loginPassword = password
            return transport
        }
    }

    private class FakeTransport(
        override val credential: YaResumeCredential,
    ) : YaMessageTransport {
        var closed = false
        override val resumed = false

        override fun send(message: JSONObject) = error("Not used")
        override suspend fun receive(): JSONObject = error("Not used")
        override suspend fun awaitClosed() = Unit

        override suspend fun closeAndAwait() {
            closed = true
        }

        override fun cancel() {
            closed = true
        }
    }
}
