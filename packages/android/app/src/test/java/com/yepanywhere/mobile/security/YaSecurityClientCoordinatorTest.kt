package com.yepanywhere.mobile.security

import com.yepanywhere.mobile.connection.YaMessageTransport
import com.yepanywhere.mobile.connection.YaResumeCredential
import com.yepanywhere.mobile.connection.YaSecureTransportCrypto
import com.yepanywhere.mobile.connection.YaSrpAuthenticationMethod
import com.yepanywhere.mobile.connection.YaSrpTransportBinding
import com.yepanywhere.mobile.profiles.YaPairedServerProfile
import com.yepanywhere.mobile.profiles.YaPairedServerRepository
import com.yepanywhere.mobile.profiles.YaPairedServerSnapshot
import com.yepanywhere.mobile.profiles.YaSecurityClientBinding
import com.yepanywhere.mobile.profiles.YaServerRoute
import com.yepanywhere.mobile.profiles.YaStoredResumeCredential
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class YaSecurityClientCoordinatorTest {
    @Test
    fun registersAPendingKeyAndPinsTheReturnedFingerprint() = runBlocking {
        val fixture = Fixture(pendingProfile())
        val transport = fixture.transport { request ->
            when (request.getString("path")) {
                "/api/version" -> response(
                    request,
                    200,
                    JSONObject().put(
                        "capabilities",
                        JSONArray().put(YaSecurityClientProtocol.CAPABILITY),
                    ),
                )
                YaSecurityClientProtocol.REGISTER_ROUTE -> response(
                    request,
                    201,
                    registeredClient(CLIENT_ID, fixture.fingerprint),
                )
                else -> error("Unexpected request")
            }
        }

        val updated = fixture.coordinator.ensure(fixture.profile, transport)

        assertEquals(CLIENT_ID, updated.securityClient?.clientId)
        assertNull(updated.securityClient?.pendingRequestId)
        assertEquals(CLIENT_ID, fixture.repository.value.profile.securityClient?.clientId)
        assertEquals(
            listOf("/api/version", YaSecurityClientProtocol.REGISTER_ROUTE),
            transport.sent.map { it.getString("path") },
        )
        assertTrue(
            transport.sent.last().getJSONObject("body")
                .getJSONObject("key").getString("signature").isNotBlank(),
        )
    }

    @Test
    fun unknownCheckInQuietlyRegistersTheSameKeyAsANewClient() = runBlocking {
        val profile = pendingProfile().copy(
            securityClient = YaSecurityClientBinding.registered(KEY_ALIAS, CLIENT_ID),
        )
        val fixture = Fixture(profile)
        val transport = fixture.transport { request ->
            when (request.getString("path")) {
                "/api/version" -> capableVersion(request)
                YaSecurityClientProtocol.checkInRoute(CLIENT_ID) -> response(
                    request,
                    404,
                    JSONObject().put("code", "security_client_unknown"),
                )
                YaSecurityClientProtocol.REGISTER_ROUTE -> response(
                    request,
                    201,
                    registeredClient(NEW_CLIENT_ID, fixture.fingerprint),
                )
                else -> error("Unexpected request")
            }
        }

        val updated = fixture.coordinator.ensure(profile, transport)

        assertEquals(NEW_CLIENT_ID, updated.securityClient?.clientId)
        assertEquals(KEY_ALIAS, updated.securityClient?.keyAlias)
        assertNotEquals(CLIENT_ID, fixture.repository.value.profile.securityClient?.clientId)
        assertFalse(fixture.keys.deleted)
    }

    @Test
    fun revokedCheckInDeletesTheKeyAndClearsTheResumeCredential() {
        val profile = pendingProfile().copy(
            securityClient = YaSecurityClientBinding.registered(KEY_ALIAS, CLIENT_ID),
        )
        val fixture = Fixture(profile, withCredential = true)
        val transport = fixture.transport { request ->
            when (request.getString("path")) {
                "/api/version" -> capableVersion(request)
                YaSecurityClientProtocol.checkInRoute(CLIENT_ID) -> response(
                    request,
                    410,
                    JSONObject().put("code", "security_client_revoked"),
                )
                else -> error("Unexpected request")
            }
        }

        assertThrows(YaSecurityClientRevokedException::class.java) {
            runBlocking { fixture.coordinator.ensure(profile, transport) }
        }

        assertTrue(fixture.keys.deleted)
        assertTrue(checkNotNull(fixture.repository.value.profile.securityClient).revoked)
        assertNull(fixture.repository.value.resumeCredential)
    }

    @Test
    fun missingCapabilityMakesNoSecurityClientRequest() = runBlocking {
        val fixture = Fixture(pendingProfile())
        val transport = fixture.transport { request ->
            response(request, 200, JSONObject().put("capabilities", JSONArray()))
        }

        val updated = fixture.coordinator.ensure(fixture.profile, transport)

        assertTrue(checkNotNull(updated.securityClient).capabilityMissing)
        assertEquals(listOf("/api/version"), transport.sent.map { it.getString("path") })
    }

    private class Fixture(
        val profile: YaPairedServerProfile,
        withCredential: Boolean = false,
    ) {
        val keys = FakeKeys()
        val fingerprint = YaSecurityClientProtocol.fingerprint(keys.publicKey)
        val repository = FakeRepository(
            YaPairedServerSnapshot(
                profile,
                if (withCredential) storedCredential(profile.username) else null,
            ),
        )
        val coordinator = YaSecurityClientCoordinator(
            repository = repository,
            keys = keys,
            descriptors = YaSecurityClientDescriptorProvider {
                JSONObject()
                    .put("installationId", profile.id)
                    .put("deviceClass", "phone")
                    .put("appName", "Yep Anywhere")
                    .put("appVersion", "0.1.0")
                    .put("osName", "Android")
                    .put("osVersion", "16")
                    .put("osApiLevel", 36)
                    .put("packageName", "com.yepanywhere.mobile")
                    .put("supportedProofs", JSONArray().put("continuity-key"))
            },
        )

        fun transport(responder: (JSONObject) -> JSONObject): FakeTransport =
            FakeTransport(responder)
    }

    private class FakeKeys : YaSecurityClientKeyStore {
        val publicKey = byteArrayOf(1, 2, 3, 4, 5)
        var deleted = false

        override fun ensureKey(alias: String) {
            check(alias == KEY_ALIAS)
        }

        override fun publicKeySpki(alias: String): ByteArray = publicKey.copyOf()

        override fun sign(alias: String, message: ByteArray): ByteArray {
            check(message.isNotEmpty())
            return byteArrayOf(6, 7, 8)
        }

        override fun delete(alias: String) {
            deleted = true
        }
    }

    private class FakeRepository(
        var value: YaPairedServerSnapshot,
    ) : YaPairedServerRepository {
        override suspend fun snapshot(profileId: String): YaPairedServerSnapshot? =
            value.takeIf { it.profile.id == profileId }

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
            value = value.copy(resumeCredential = resumeCredential)
        }
    }

    private class FakeTransport(
        private val responder: (JSONObject) -> JSONObject,
    ) : YaMessageTransport {
        override val credential = credential("remote-user")
        override val resumed = false
        override val securityBinding = YaSrpTransportBinding(
            sessionId = credential.sessionId,
            transportNonce = "transport-nonce",
            authenticationMethod = YaSrpAuthenticationMethod.FULL,
        )
        val sent = CopyOnWriteArrayList<JSONObject>()
        private val incoming = Channel<JSONObject>(Channel.UNLIMITED)

        override fun send(message: JSONObject) {
            val copy = JSONObject(message.toString())
            sent += copy
            check(incoming.trySend(responder(copy)).isSuccess)
        }

        override suspend fun receive(): JSONObject = incoming.receive()
        override suspend fun awaitClosed() = Unit
        override suspend fun closeAndAwait() = Unit
        override fun cancel() = Unit
    }

    companion object {
        private const val PROFILE_ID = "11111111-1111-4111-8111-111111111111"
        private const val ROUTE_ID = "22222222-2222-4222-8222-222222222222"
        private const val REQUEST_ID = "33333333-3333-4333-8333-333333333333"
        private const val CLIENT_ID = "44444444-4444-4444-8444-444444444444"
        private const val NEW_CLIENT_ID = "55555555-5555-4555-8555-555555555555"
        private const val KEY_ALIAS = "ya_security_client_p256_v1_$PROFILE_ID"

        private fun pendingProfile(): YaPairedServerProfile = YaPairedServerProfile(
            id = PROFILE_ID,
            label = "Pixel",
            username = "remote-user",
            routes = listOf(
                YaServerRoute(
                    id = ROUTE_ID,
                    kind = com.yepanywhere.mobile.profiles.YaServerRouteKind.DIRECT,
                    websocketUrl = "wss://desktop.example.test/api/ws",
                ),
            ),
            preferredRouteId = ROUTE_ID,
            createdAtEpochMs = 1_000,
            lastConnectedAtEpochMs = null,
            securityClient = YaSecurityClientBinding.pending(KEY_ALIAS, REQUEST_ID),
        )

        private fun credential(username: String): YaResumeCredential = YaResumeCredential(
            username = username,
            sessionId = "resume-session",
            baseKey = ByteArray(YaSecureTransportCrypto.KEY_BYTES),
            resumeProtocolVersion = YaSecureTransportCrypto.RESUME_PROTOCOL_VERSION,
        )

        private fun storedCredential(username: String): YaStoredResumeCredential =
            YaStoredResumeCredential(credential(username), 1_000, null)

        private fun capableVersion(request: JSONObject): JSONObject = response(
            request,
            200,
            JSONObject().put(
                "capabilities",
                JSONArray().put(YaSecurityClientProtocol.CAPABILITY),
            ),
        )

        private fun registeredClient(
            clientId: String,
            fingerprint: String,
        ): JSONObject = JSONObject().put(
            "client",
            JSONObject()
                .put("clientId", clientId)
                .put(
                    "proofs",
                    JSONArray().put(
                        JSONObject()
                            .put("type", "continuity-key")
                            .put("keyFingerprint", fingerprint),
                    ),
                ),
        )

        private fun response(
            request: JSONObject,
            status: Int,
            body: JSONObject,
        ): JSONObject = JSONObject()
            .put("type", "response")
            .put("id", request.getString("id"))
            .put("status", status)
            .put("body", body)
    }
}
