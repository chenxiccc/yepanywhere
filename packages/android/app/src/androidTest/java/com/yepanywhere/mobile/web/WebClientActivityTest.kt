package com.yepanywhere.mobile.web

import android.app.Activity
import android.app.Instrumentation.ActivityResult
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.espresso.intent.Intents
import androidx.test.espresso.intent.Intents.intending
import androidx.test.espresso.intent.matcher.IntentMatchers.hasAction
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

    @Test
    fun nativeHostIsAbsentFromAnUnapprovedOrigin() {
        ActivityScenario.launch(WebClientActivity::class.java).use { scenario ->
            awaitJavaScript(scenario, "document.readyState", "\"complete\"")
            scenario.onActivity { activity ->
                activity.findViewById<WebView>(R.id.web_client).apply {
                    webViewClient = WebViewClient()
                    loadDataWithBaseURL(
                        "https://untrusted.example/",
                        "<html><body>untrusted</body></html>",
                        "text/html",
                        Charsets.UTF_8.name(),
                        null,
                    )
                }
            }

            awaitJavaScript(
                scenario,
                "document.body.textContent",
                "\"untrusted\"",
            )
            assertEquals(
                "\"undefined\"",
                evaluateJavaScript(scenario, "typeof window.yaNative"),
            )
        }
    }

    @Test
    fun nativeHostDoesNotReplyToASubframe() {
        ActivityScenario.launch(WebClientActivity::class.java).use { scenario ->
            awaitJavaScript(scenario, "document.readyState", "\"complete\"")
            evaluateJavaScript(
                scenario,
                """
                const frame = document.createElement("iframe");
                frame.id = "ya-native-test-frame";
                document.body.appendChild(frame);
                true;
                """.trimIndent(),
            )
            awaitJavaScript(
                scenario,
                """
                document.getElementById("ya-native-test-frame")
                  ?.contentDocument?.readyState ?? "missing"
                """.trimIndent(),
                "\"complete\"",
            )
            evaluateJavaScript(
                scenario,
                """
                window.__yaNativeFrameResult = "pending";
                const channel = document.getElementById("ya-native-test-frame")
                  .contentWindow.yaNative;
                if (!channel) {
                  window.__yaNativeFrameResult = "absent";
                } else {
                  channel.onmessage = () => {
                    window.__yaNativeFrameResult = "reply";
                  };
                  channel.postMessage(
                    '{"protocol":1,"id":"frame-test","method":"host.describe"}'
                  );
                  setTimeout(() => {
                    if (window.__yaNativeFrameResult === "pending") {
                      window.__yaNativeFrameResult = "no-reply";
                    }
                  }, 1000);
                }
                true;
                """.trimIndent(),
            )

            awaitJavaScriptOneOf(
                scenario,
                "window.__yaNativeFrameResult",
                setOf("\"absent\"", "\"no-reply\""),
            )
            assertEquals(
                "false",
                evaluateJavaScript(
                    scenario,
                    "window.__yaNativeFrameResult === 'reply'",
                ),
            )
        }
    }

    @Test
    fun activityRecreationRestoresTheClientAndNativeHost() {
        ActivityScenario.launch(WebClientActivity::class.java).use { scenario ->
            awaitJavaScript(scenario, "document.readyState", "\"complete\"")

            scenario.recreate()

            awaitJavaScript(scenario, "document.readyState", "\"complete\"")
            assertEquals("\"object\"", evaluateJavaScript(scenario, "typeof window.yaNative"))
            requestHostDescription(scenario, "recreated-document")
        }
    }

    @Test
    fun rotationRestoresTheClientAndNativeHost() {
        ActivityScenario.launch(WebClientActivity::class.java).use { scenario ->
            awaitJavaScript(scenario, "document.readyState", "\"complete\"")
            try {
                scenario.onActivity { activity ->
                    activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
                }
                awaitOrientation(scenario, Configuration.ORIENTATION_LANDSCAPE)
                awaitJavaScript(scenario, "document.readyState", "\"complete\"")
                awaitJavaScript(scenario, "typeof window.yaNative", "\"object\"")
                requestHostDescription(scenario, "rotated-document")
            } finally {
                scenario.onActivity { activity ->
                    activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                }
                awaitOrientation(scenario, Configuration.ORIENTATION_PORTRAIT)
            }
        }
    }

    @Test
    fun backNavigatesWebHistoryBeforeFinishingTheActivity() {
        ActivityScenario.launch(WebClientActivity::class.java).use { scenario ->
            awaitJavaScript(scenario, "document.readyState", "\"complete\"")
            val historyUrl = "https://appassets.androidplatform.net/debug-streaming.html"
            scenario.onActivity { activity ->
                activity.findViewById<WebView>(R.id.web_client).loadUrl(historyUrl)
            }
            awaitJavaScript(
                scenario,
                "window.location.pathname",
                "\"/debug-streaming.html\"",
            )
            awaitWebViewCondition(
                scenario,
                "WebView history did not include the second document",
            ) { view ->
                view.canGoBack()
            }

            scenario.onActivity { activity ->
                activity.onBackPressedDispatcher.onBackPressed()
            }

            awaitWebViewCondition(
                scenario,
                "WebView did not leave the second history document",
            ) { view ->
                view.url != null && view.url != historyUrl
            }
            assertEquals(Lifecycle.State.RESUMED, scenario.state)
        }
    }

    @Test
    fun externalHttpsNavigationLeavesThePrivilegedWebView() {
        Intents.init()
        try {
            intending(hasAction(Intent.ACTION_VIEW)).respondWith(
                ActivityResult(Activity.RESULT_OK, null),
            )
            ActivityScenario.launch(WebClientActivity::class.java).use { scenario ->
                awaitJavaScript(scenario, "document.readyState", "\"complete\"")
                evaluateJavaScript(
                    scenario,
                    "window.location.href = 'https://example.com/android-contract'; true",
                )

                awaitExternalIntent("https://example.com/android-contract")
                assertEquals(
                    "\"https://appassets.androidplatform.net\"",
                    evaluateJavaScript(scenario, "window.location.origin"),
                )
            }
        } finally {
            Intents.release()
        }
    }

    private fun requestHostDescription(
        scenario: ActivityScenario<WebClientActivity>,
        requestId: String,
    ) {
        evaluateJavaScript(
            scenario,
            """
            window.__yaNativeTestResponse = null;
            window.yaNative.onmessage = (event) => {
              window.__yaNativeTestResponse = event.data;
            };
            window.yaNative.postMessage(
              JSON.stringify({
                protocol: 1,
                id: ${jsonString(requestId)},
                method: "host.describe"
              })
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

    private fun jsonString(value: String): String {
        return org.json.JSONObject.quote(value)
    }

    private fun awaitOrientation(
        scenario: ActivityScenario<WebClientActivity>,
        expected: Int,
    ) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        var actual = Configuration.ORIENTATION_UNDEFINED
        while (System.nanoTime() < deadline) {
            scenario.onActivity { activity ->
                actual = activity.resources.configuration.orientation
            }
            if (actual == expected) {
                return
            }
            Thread.sleep(100)
        }
        assertEquals(expected, actual)
    }

    private fun awaitExternalIntent(expectedUrl: String) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        var matched = false
        while (System.nanoTime() < deadline) {
            matched = Intents.getIntents().any { intent ->
                intent.action == Intent.ACTION_VIEW && intent.dataString == expectedUrl
            }
            if (matched) {
                return
            }
            Thread.sleep(100)
        }
        assertTrue("External VIEW intent was not recorded", matched)
    }

    private fun awaitWebViewCondition(
        scenario: ActivityScenario<WebClientActivity>,
        failureMessage: String,
        condition: (WebView) -> Boolean,
    ) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        var matched = false
        while (System.nanoTime() < deadline) {
            scenario.onActivity { activity ->
                matched = condition(activity.findViewById(R.id.web_client))
            }
            if (matched) {
                return
            }
            Thread.sleep(100)
        }
        assertTrue(failureMessage, matched)
    }

    private fun awaitJavaScript(
        scenario: ActivityScenario<WebClientActivity>,
        script: String,
        expected: String,
    ) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        var actual = ""
        while (System.nanoTime() < deadline) {
            actual = evaluateJavaScriptOrNull(scenario, script, 1) ?: "<no callback>"
            if (actual == expected) {
                return
            }
            Thread.sleep(100)
        }
        assertEquals(expected, actual)
    }

    private fun awaitJavaScriptOneOf(
        scenario: ActivityScenario<WebClientActivity>,
        script: String,
        expected: Set<String>,
    ) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        var actual = ""
        while (System.nanoTime() < deadline) {
            actual = evaluateJavaScriptOrNull(scenario, script, 1) ?: "<no callback>"
            if (actual in expected) {
                return
            }
            Thread.sleep(100)
        }
        assertTrue("Expected one of $expected but was $actual", actual in expected)
    }

    private fun evaluateJavaScript(
        scenario: ActivityScenario<WebClientActivity>,
        script: String,
    ): String {
        return evaluateJavaScriptOrNull(scenario, script, 5)
            ?: throw AssertionError("JavaScript evaluation timed out")
    }

    private fun evaluateJavaScriptOrNull(
        scenario: ActivityScenario<WebClientActivity>,
        script: String,
        timeoutSeconds: Long,
    ): String? {
        val result = AtomicReference<String>()
        val completed = CountDownLatch(1)
        scenario.onActivity { activity ->
            activity.findViewById<WebView>(R.id.web_client).evaluateJavascript(script) { value ->
                result.set(value)
                completed.countDown()
            }
        }
        return if (completed.await(timeoutSeconds, TimeUnit.SECONDS)) {
            result.get()
        } else {
            null
        }
    }
}
