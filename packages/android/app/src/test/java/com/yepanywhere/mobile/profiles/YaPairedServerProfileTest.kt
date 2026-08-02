package com.yepanywhere.mobile.profiles

import com.yepanywhere.mobile.connection.YaResumeCredential
import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class YaPairedServerProfileTest {
    @Test
    fun profileMetadataRoundTripsWithoutCredentialMaterial() {
        val direct = YaServerRoute(
            id = UUID.randomUUID().toString(),
            kind = YaServerRouteKind.DIRECT,
            websocketUrl = "wss://desktop.example.test/api/ws",
        )
        val relay = YaServerRoute(
            id = UUID.randomUUID().toString(),
            kind = YaServerRouteKind.RELAY,
            websocketUrl = "wss://relay.example.test/ws",
            relayTarget = "my-server",
        )
        val profile = YaPairedServerProfile(
            id = UUID.randomUUID().toString(),
            label = "Studio",
            username = "remote-user",
            routes = listOf(direct, relay),
            preferredRouteId = relay.id,
            createdAtEpochMs = 1_800_000_000_000,
            lastConnectedAtEpochMs = null,
            securityClient = YaSecurityClientBinding.pending(
                keyAlias = "ya_security_client_p256_v1_test",
                requestId = "11111111-1111-4111-8111-111111111111",
            ),
        )

        val encoded = YaPairedServerCodec.encodeProfiles(listOf(profile))
        assertEquals(listOf(profile), YaPairedServerCodec.decodeProfiles(encoded))
        assertNull(YaPairedServerCodec.decodeProfiles(encoded).single().lastConnectedAtEpochMs)
    }

    @Test
    fun rejectsTheDisposableDevelopmentV1ProfileSchema() {
        val v1 = """
            {"version":1,"profiles":[]}
        """.trimIndent()

        assertThrows(IllegalStateException::class.java) {
            YaPairedServerCodec.decodeProfiles(v1)
        }
    }

    @Test
    fun securityClientBindingDistinguishesPendingRegisteredAndRevoked() {
        val pending = YaSecurityClientBinding.pending(
            keyAlias = "ya_security_client_p256_v1_test",
            requestId = "11111111-1111-4111-8111-111111111111",
        )
        val registered = YaSecurityClientBinding.registered(
            keyAlias = checkNotNull(pending.keyAlias),
            clientId = "22222222-2222-4222-8222-222222222222",
        )
        val revoked = YaSecurityClientBinding.revoked(checkNotNull(registered.clientId))

        assertNull(pending.clientId)
        assertNull(registered.pendingRequestId)
        assertTrue(revoked.revoked)
        assertNull(revoked.keyAlias)
    }

    @Test
    fun rejectsInvalidRouteAndProfileRelationships() {
        val route = YaServerRoute.direct("wss://desktop.example.test/api/ws")

        assertThrows(IllegalArgumentException::class.java) {
            YaServerRoute.direct("https://desktop.example.test/api/ws")
        }
        assertThrows(IllegalArgumentException::class.java) {
            YaServerRoute(
                id = UUID.randomUUID().toString(),
                kind = YaServerRouteKind.RELAY,
                websocketUrl = "wss://relay.example.test/ws",
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            YaPairedServerProfile(
                id = UUID.randomUUID().toString(),
                label = "Studio",
                username = "remote-user",
                routes = listOf(route),
                preferredRouteId = UUID.randomUUID().toString(),
                createdAtEpochMs = 0,
                lastConnectedAtEpochMs = null,
            )
        }
    }

    @Test
    fun treatsTheServerResumeLimitsAsAConservativeLocalExpiry() {
        val establishedAt = 1_800_000_000_000
        val credential = YaStoredResumeCredential(
            credential = YaResumeCredential(
                username = "remote-user",
                sessionId = "session-id",
                baseKey = ByteArray(32),
                resumeProtocolVersion = 3,
            ),
            establishedAtEpochMs = establishedAt,
            lastResumedAtEpochMs = establishedAt + 6L * 24 * 60 * 60 * 1000,
        )

        assertTrue(credential.isEligibleAt(establishedAt + 13L * 24 * 60 * 60 * 1000))
        assertFalse(credential.isEligibleAt(establishedAt + 13L * 24 * 60 * 60 * 1000 + 1))

        val activeAtAbsoluteLimit = credential.copy(
            lastResumedAtEpochMs = establishedAt + 29L * 24 * 60 * 60 * 1000,
        )
        assertTrue(activeAtAbsoluteLimit.isEligibleAt(establishedAt + 30L * 24 * 60 * 60 * 1000))
        assertFalse(
            activeAtAbsoluteLimit.isEligibleAt(
                establishedAt + 30L * 24 * 60 * 60 * 1000 + 1,
            ),
        )
    }
}
