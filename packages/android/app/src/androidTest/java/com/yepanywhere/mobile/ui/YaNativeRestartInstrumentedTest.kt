package com.yepanywhere.mobile.ui

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.yepanywhere.mobile.YepAnywhereApplication
import com.yepanywhere.mobile.profiles.YaServerRoute
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertNotNull
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class YaNativeRestartInstrumentedTest {
    @Test
    fun provisionsATestOwnedProfileForAHostDrivenRestart() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val arguments = InstrumentationRegistry.getArguments()
        assumeTrue(arguments.getString("yaRestartPhase") == "provision")
        val wsUrl = arguments.getString("yaProbeWsUrl")
        val username = arguments.getString("yaProbeUsername")
        val password = arguments.getString("yaProbePassword")
        assumeTrue(wsUrl != null && username != null && password != null)
        val application = instrumentation.targetContext.applicationContext
            as YepAnywhereApplication
        val store = application.nativeRuntime.pairedServers
        val testPreferences = instrumentation.context.getSharedPreferences(
            TEST_PREFERENCES,
            Context.MODE_PRIVATE,
        )

        val paired = runBlocking {
            val staleTestProfileIds = store.snapshots()
                .filter { it.profile.label == TEST_PROFILE_LABEL }
                .map { it.profile.id }
            val selectedBeforeCleanup = store.selectedProfileId.first()
            staleTestProfileIds.forEach { store.forget(it) }
            val previousSelected = selectedBeforeCleanup?.takeUnless {
                it in staleTestProfileIds
            }
            testPreferences.edit()
                .putString(PREVIOUS_SELECTION_KEY, previousSelected)
                .apply()
            withTimeout(15_000) {
                application.nativeRuntime.pairing.pair(
                    label = TEST_PROFILE_LABEL,
                    username = checkNotNull(username),
                    password = checkNotNull(password),
                    route = YaServerRoute.direct(checkNotNull(wsUrl)),
                )
            }
        }

        assertNotNull(runBlocking { store.snapshot(paired.id)?.resumeCredential })
    }

    @Test
    fun removesTheTestOwnedRestartProfile() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        assumeTrue(
            InstrumentationRegistry.getArguments().getString("yaRestartPhase") == "cleanup",
        )
        val application = instrumentation.targetContext.applicationContext
            as YepAnywhereApplication
        val store = application.nativeRuntime.pairedServers
        val testPreferences = instrumentation.context.getSharedPreferences(
            TEST_PREFERENCES,
            Context.MODE_PRIVATE,
        )

        runBlocking {
            store.snapshots()
                .filter { it.profile.label == TEST_PROFILE_LABEL }
                .forEach { store.forget(it.profile.id) }
            val previousSelected = testPreferences.getString(PREVIOUS_SELECTION_KEY, null)
            if (
                previousSelected != null &&
                store.snapshot(previousSelected) != null
            ) {
                store.select(previousSelected)
            }
        }
        testPreferences.edit().remove(PREVIOUS_SELECTION_KEY).apply()
    }

    companion object {
        const val TEST_PROFILE_LABEL = "Disposable Android restart probe"
        private const val TEST_PREFERENCES = "ya_native_restart_probe"
        private const val PREVIOUS_SELECTION_KEY = "previous_selection"
    }
}
