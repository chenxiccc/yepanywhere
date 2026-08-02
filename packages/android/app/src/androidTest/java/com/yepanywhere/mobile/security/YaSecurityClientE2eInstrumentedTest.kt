package com.yepanywhere.mobile.security

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.yepanywhere.mobile.connection.YaMessageTransport
import com.yepanywhere.mobile.connection.YaNativeProfileConnector
import com.yepanywhere.mobile.connection.YaNativeSecureConnection
import com.yepanywhere.mobile.connection.YaPairingCoordinator
import com.yepanywhere.mobile.connection.YaServerConnectionManager
import com.yepanywhere.mobile.profiles.YaPairedServerProfile
import com.yepanywhere.mobile.profiles.YaPairedServerRepository
import com.yepanywhere.mobile.profiles.YaPairedServerSnapshot
import com.yepanywhere.mobile.profiles.YaSecurityClientBinding
import com.yepanywhere.mobile.profiles.YaServerRoute
import com.yepanywhere.mobile.profiles.YaStoredResumeCredential
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class YaSecurityClientE2eInstrumentedTest {
    @Test
    fun pairsChecksInRecoversUnknownAndRecognizesRevocation() {
        val arguments = InstrumentationRegistry.getArguments()
        val wsUrl = arguments.getString("yaProbeWsUrl")
        val username = arguments.getString("yaProbeUsername")
        val password = arguments.getString("yaProbePassword")
        assumeTrue(
            "Security-client E2E arguments are intentionally absent in config-free CI",
            wsUrl != null && username != null && password != null,
        )

        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val httpClient = OkHttpClient.Builder()
            .connectTimeout(5, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build()
        val keys = AndroidKeystoreSecurityClientKeyStore()
        var keyAlias: String? = null
        try {
            val connection = YaNativeSecureConnection(httpClient)
            val connector = YaNativeProfileConnector(connection)
            val route = YaServerRoute.direct(checkNotNull(wsUrl))
            val repository = InMemoryPairedServerRepository()
            val securityClients = YaSecurityClientCoordinator(
                repository = repository,
                keys = keys,
                descriptors = YaAndroidSecurityClientDescriptorProvider(context),
            )
            val pairing = YaPairingCoordinator(
                repository = repository,
                connector = connector,
                securityClients = securityClients,
            )

            runBlocking {
                val paired = withTimeout(STEP_TIMEOUT_MS) {
                    pairing.pair(
                        label = "Pixel security checkpoint",
                        username = checkNotNull(username),
                        password = checkNotNull(password),
                        route = route,
                    )
                }
                val firstBinding = checkNotNull(paired.securityClient)
                val firstClientId = checkNotNull(firstBinding.clientId)
                keyAlias = checkNotNull(firstBinding.keyAlias)
                val expectedFingerprint = YaSecurityClientProtocol.fingerprint(
                    keys.publicKeySpki(checkNotNull(keyAlias)),
                )

                val manager = YaServerConnectionManager(
                    profileId = paired.id,
                    repository = repository,
                    connector = connector,
                    securityClients = securityClients,
                    retryDelaysMs = emptyList(),
                )
                val lease = manager.acquire()
                val checkedIn = withTimeout(STEP_TIMEOUT_MS) {
                    lease.request("GET", "/security/clients/$firstClientId")
                }
                val checkedInClient = (checkedIn.body as JSONObject).getJSONObject("client")
                assertEquals("srp-resume", checkedInClient.getString("lastAuthenticationMethod"))
                assertEquals(expectedFingerprint, continuityFingerprint(checkedInClient))
                lease.releaseAndAwait()
                manager.shutdownAndAwait()

                val unknownClientId = UUID.randomUUID().toString()
                repository.updateSecurityClientBinding(
                    paired.id,
                    YaSecurityClientBinding.registered(checkNotNull(keyAlias), unknownClientId),
                )
                val fullForUnknown = connector.login(
                    route,
                    checkNotNull(username),
                    checkNotNull(password),
                )
                val recovered = try {
                    withTimeout(STEP_TIMEOUT_MS) {
                        securityClients.ensure(
                            checkNotNull(repository.snapshot(paired.id)).profile,
                            fullForUnknown,
                        )
                    }
                } finally {
                    fullForUnknown.closeAndAwait()
                }
                val recoveredClientId = checkNotNull(recovered.securityClient?.clientId)
                assertNotEquals(unknownClientId, recoveredClientId)
                assertEquals(checkNotNull(keyAlias), recovered.securityClient?.keyAlias)

                val fullForRevocation = connector.login(
                    route,
                    checkNotNull(username),
                    checkNotNull(password),
                )
                try {
                    securityClients.ensure(
                        checkNotNull(repository.snapshot(paired.id)).profile,
                        fullForRevocation,
                    )
                    val response = muxRequest(
                        fullForRevocation,
                        method = "DELETE",
                        path = "/api/security/clients/$recoveredClientId",
                    )
                    assertEquals(200, response.getInt("status"))
                } finally {
                    runCatching { fullForRevocation.closeAndAwait() }
                }

                val fullAfterRevocation = connector.login(
                    route,
                    checkNotNull(username),
                    checkNotNull(password),
                )
                try {
                    assertThrows(YaSecurityClientRevokedException::class.java) {
                        runBlocking {
                            securityClients.ensure(
                                checkNotNull(repository.snapshot(paired.id)).profile,
                                fullAfterRevocation,
                            )
                        }
                    }
                } finally {
                    fullAfterRevocation.closeAndAwait()
                }
                val revoked = checkNotNull(repository.snapshot(paired.id))
                assertTrue(checkNotNull(revoked.profile.securityClient).revoked)
                assertEquals(recoveredClientId, revoked.profile.securityClient?.clientId)
                assertNull(revoked.resumeCredential)
            }
        } finally {
            keyAlias?.let { runCatching { keys.delete(it) } }
            httpClient.connectionPool.evictAll()
            httpClient.dispatcher.executorService.shutdown()
        }
    }

    private suspend fun muxRequest(
        transport: YaMessageTransport,
        method: String,
        path: String,
    ): JSONObject {
        val id = UUID.randomUUID().toString()
        transport.send(
            JSONObject()
                .put("type", "request")
                .put("id", id)
                .put("method", method)
                .put("path", path)
                .put("headers", JSONObject().put("X-Yep-Anywhere", "true")),
        )
        return withTimeout(STEP_TIMEOUT_MS) {
            repeat(32) {
                val message = transport.receive()
                if (message.optString("type") == "response" && message.optString("id") == id) {
                    return@withTimeout message
                }
            }
            error("Bounded mux response was not received")
        }
    }

    private fun continuityFingerprint(client: JSONObject): String {
        val proofs = client.getJSONArray("proofs")
        return (0 until proofs.length())
            .map { proofs.getJSONObject(it) }
            .first { it.getString("type") == "continuity-key" }
            .getString("keyFingerprint")
    }

    private class InMemoryPairedServerRepository : YaPairedServerRepository {
        private var value: YaPairedServerSnapshot? = null

        override suspend fun snapshot(profileId: String): YaPairedServerSnapshot? =
            value?.takeIf { it.profile.id == profileId }

        override suspend fun upsert(
            profile: YaPairedServerProfile,
            resumeCredential: YaStoredResumeCredential?,
            select: Boolean,
        ) {
            value = YaPairedServerSnapshot(profile, resumeCredential)
        }

        override suspend fun clearCredential(profileId: String) {
            value = checkNotNull(value).copy(resumeCredential = null)
        }

        override suspend fun recordSuccessfulAuthentication(
            profileId: String,
            routeId: String,
            resumeCredential: YaStoredResumeCredential,
            connectedAtEpochMs: Long,
        ) {
            val current = checkNotNull(value)
            value = current.copy(
                profile = current.profile.copy(
                    preferredRouteId = routeId,
                    lastConnectedAtEpochMs = connectedAtEpochMs,
                ),
                resumeCredential = resumeCredential,
            )
        }
    }

    companion object {
        private const val STEP_TIMEOUT_MS = 30_000L
    }
}
