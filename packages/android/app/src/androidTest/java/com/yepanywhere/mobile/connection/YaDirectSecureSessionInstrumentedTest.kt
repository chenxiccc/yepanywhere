package com.yepanywhere.mobile.connection

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.yepanywhere.mobile.profiles.YaPairedServerProfile
import com.yepanywhere.mobile.profiles.YaPairedServerRepository
import com.yepanywhere.mobile.profiles.YaPairedServerSnapshot
import com.yepanywhere.mobile.profiles.YaServerRoute
import com.yepanywhere.mobile.profiles.YaStoredResumeCredential
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class YaDirectSecureSessionInstrumentedTest {
    @Test
    fun negotiatesFullSrpAndResumeWithEncryptedPingPong() {
        val arguments = InstrumentationRegistry.getArguments()
        val wsUrl = arguments.getString("yaProbeWsUrl")
        val username = arguments.getString("yaProbeUsername")
        val password = arguments.getString("yaProbePassword")
        val relayWsUrl = arguments.getString("yaProbeRelayWsUrl")
        assumeTrue(
            "Native direct-session probe arguments are intentionally absent in config-free CI",
            wsUrl != null && username != null && password != null,
        )

        val httpClient = OkHttpClient.Builder()
            .connectTimeout(5, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build()
        try {
            val connection = YaNativeSecureConnection(httpClient)
            runBlocking {
                val full = withTimeout(15_000) {
                    connection.loginAndProbe(
                        wsUrl = checkNotNull(wsUrl),
                        username = checkNotNull(username),
                        password = checkNotNull(password),
                    )
                }
                assertFalse(full.resumed)
                assertEquals(username, full.credential.username)
                assertTrue(full.credential.sessionId.isNotBlank())
                assertEquals(
                    YaSecureTransportCrypto.KEY_BYTES,
                    full.credential.keySize,
                )

                val resumed = withTimeout(15_000) {
                    connection.resumeAndProbe(checkNotNull(wsUrl), full.credential)
                }
                assertTrue(resumed.resumed)
                assertEquals(full.credential, resumed.credential)

                val now = System.currentTimeMillis()
                val route = YaServerRoute.direct(checkNotNull(wsUrl))
                val profile = YaPairedServerProfile.create(
                    label = "Disposable direct server",
                    username = checkNotNull(username),
                    route = route,
                    nowEpochMs = now,
                )
                val repository = InMemoryPairedServerRepository(
                    YaPairedServerSnapshot(
                        profile = profile,
                        resumeCredential = YaStoredResumeCredential(
                            credential = resumed.credential,
                            establishedAtEpochMs = now,
                            lastResumedAtEpochMs = null,
                        ),
                    ),
                )
                val manager = YaServerConnectionManager(
                    profileId = profile.id,
                    repository = repository,
                    connector = YaNativeProfileConnector(connection),
                )
                val firstLease = manager.acquire()
                val sessions = withTimeout(15_000) {
                    firstLease.request("GET", "/sessions")
                }
                assertEquals(200, sessions.status)
                assertTrue(sessions.body != null)
                val activity = withTimeout(15_000) {
                    firstLease.subscribe(channel = "activity")
                }
                val connected = withTimeout(15_000) { activity.events.first() }
                assertEquals("connected", connected.eventType)
                activity.close()
                firstLease.releaseAndAwait()
                assertEquals(YaConnectionPhase.IDLE, manager.state.value.phase)

                val restartedLease = manager.acquire()
                val afterRestart = withTimeout(15_000) {
                    restartedLease.request("GET", "/sessions")
                }
                assertEquals(200, afterRestart.status)
                restartedLease.releaseAndAwait()
                manager.shutdownAndAwait()

                if (relayWsUrl != null) {
                    val unavailableDirectRoute = YaServerRoute.direct(
                        "ws://127.0.0.1:38903/api/ws",
                    )
                    val relayRoute = YaServerRoute.relay(
                        websocketUrl = relayWsUrl,
                        relayTarget = checkNotNull(username),
                    )
                    val relayProfile = YaPairedServerProfile.create(
                        label = "Disposable relay server",
                        username = checkNotNull(username),
                        route = unavailableDirectRoute,
                        nowEpochMs = now,
                    ).copy(routes = listOf(unavailableDirectRoute, relayRoute))
                    val relayRepository = InMemoryPairedServerRepository(
                        YaPairedServerSnapshot(
                            profile = relayProfile,
                            resumeCredential = YaStoredResumeCredential(
                                credential = resumed.credential,
                                establishedAtEpochMs = now,
                                lastResumedAtEpochMs = null,
                            ),
                        ),
                    )
                    val relayManager = YaServerConnectionManager(
                        profileId = relayProfile.id,
                        repository = relayRepository,
                        connector = YaNativeProfileConnector(connection),
                    )
                    val relayLease = relayManager.acquire()
                    val relaySessions = withTimeout(15_000) {
                        relayLease.request("GET", "/sessions")
                    }
                    assertEquals(200, relaySessions.status)
                    assertEquals(
                        relayRoute.id,
                        relayRepository.snapshot(relayProfile.id)?.profile?.preferredRouteId,
                    )
                    relayLease.releaseAndAwait()
                    assertEquals(YaConnectionPhase.IDLE, relayManager.state.value.phase)
                    relayManager.shutdownAndAwait()
                }
            }
        } finally {
            httpClient.connectionPool.evictAll()
            httpClient.dispatcher.executorService.shutdown()
        }
    }

    private class InMemoryPairedServerRepository(
        private var value: YaPairedServerSnapshot,
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
}
