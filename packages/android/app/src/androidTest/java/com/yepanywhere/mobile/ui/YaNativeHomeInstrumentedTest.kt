package com.yepanywhere.mobile.ui

import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import com.yepanywhere.mobile.MainActivity
import com.yepanywhere.mobile.YepAnywhereApplication
import com.yepanywhere.mobile.connection.YaConnectionPhase
import com.yepanywhere.mobile.profiles.YaServerRoute
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class YaNativeHomeInstrumentedTest {
    @Test
    fun displaysARealPairedServerAndReleasesItsVisibleLease() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val arguments = InstrumentationRegistry.getArguments()
        val wsUrl = arguments.getString("yaProbeWsUrl")
        val username = arguments.getString("yaProbeUsername")
        val password = arguments.getString("yaProbePassword")
        assumeTrue(
            "Native home integration arguments are intentionally absent in config-free CI",
            wsUrl != null && username != null && password != null,
        )
        val application = instrumentation.targetContext.applicationContext
            as YepAnywhereApplication
        val runtime = application.nativeRuntime
        val previouslySelected = runBlocking {
            runtime.pairedServers.selectedProfileId.first()
        }
        val profile = runBlocking {
            withTimeout(15_000) {
                runtime.pairing.pair(
                    label = "Disposable direct server",
                    username = checkNotNull(username),
                    password = checkNotNull(password),
                    route = YaServerRoute.direct(checkNotNull(wsUrl)),
                )
            }
        }

        val device = UiDevice.getInstance(instrumentation)
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        try {
            assertTrue(device.wait(Until.hasObject(By.text("Connected")), 15_000))
            assertTrue(
                device.wait(
                    Until.hasObject(By.text("Disposable direct server")),
                    5_000,
                ),
            )
            repeat(2) {
                device.swipe(
                    device.displayWidth / 2,
                    device.displayHeight * 4 / 5,
                    device.displayWidth / 2,
                    device.displayHeight / 5,
                    30,
                )
            }
            val sessionsEmpty = device.wait(
                Until.hasObject(By.text("No sessions yet")),
                15_000,
            )
            assertTrue(sessionsEmpty)
        } finally {
            scenario.close()
            runBlocking {
                val manager = runtime.connectionManager(profile.id)
                withTimeout(5_000) {
                    manager.state.first { it.phase == YaConnectionPhase.IDLE }
                }
                assertEquals(YaConnectionPhase.IDLE, manager.state.value.phase)
                runtime.pairedServers.forget(profile.id)
                if (
                    previouslySelected != null &&
                    runtime.pairedServers.snapshot(previouslySelected) != null
                ) {
                    runtime.pairedServers.select(previouslySelected)
                }
            }
        }
    }
}
