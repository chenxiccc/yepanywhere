package com.yepanywhere.mobile.web

import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.yepanywhere.mobile.R
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WebClientActivityTest {
    @Test
    fun nativeHostDescribesAndroidOverWebMessage() {
        ActivityScenario.launch(WebClientActivity::class.java).use { scenario ->
            awaitJavaScript(scenario, "document.readyState", "\"complete\"")
            assertEquals("\"object\"", evaluateJavaScript(scenario, "typeof window.yaNative"))

            evaluateJavaScript(
                scenario,
                """
                window.__yaNativeTestResponse = null;
                window.yaNative.onmessage = (event) => {
                  window.__yaNativeTestResponse = event.data;
                };
                window.yaNative.postMessage(
                  '{"protocol":1,"id":"device-test","method":"host.describe"}'
                );
                true;
                """.trimIndent(),
            )

            awaitJavaScript(
                scenario,
                """
                window.__yaNativeTestResponse === null
                  ? "pending"
                  : JSON.parse(window.__yaNativeTestResponse).result.platform
                """.trimIndent(),
                "\"android\"",
            )
        }
    }

    private fun awaitJavaScript(
        scenario: ActivityScenario<WebClientActivity>,
        script: String,
        expected: String,
    ) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        var actual = ""
        while (System.nanoTime() < deadline) {
            actual = evaluateJavaScript(scenario, script)
            if (actual == expected) {
                return
            }
            Thread.sleep(100)
        }
        assertEquals(expected, actual)
    }

    private fun evaluateJavaScript(
        scenario: ActivityScenario<WebClientActivity>,
        script: String,
    ): String {
        val result = AtomicReference<String>()
        val completed = CountDownLatch(1)
        scenario.onActivity { activity ->
            activity.findViewById<WebView>(R.id.web_client).evaluateJavascript(script) { value ->
                result.set(value)
                completed.countDown()
            }
        }
        assertTrue("JavaScript evaluation timed out", completed.await(5, TimeUnit.SECONDS))
        return result.get()
    }
}
