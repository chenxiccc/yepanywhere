package com.yepanywhere.mobile.connection

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.TimeUnit
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
            }
        } finally {
            httpClient.connectionPool.evictAll()
            httpClient.dispatcher.executorService.shutdown()
        }
    }
}
