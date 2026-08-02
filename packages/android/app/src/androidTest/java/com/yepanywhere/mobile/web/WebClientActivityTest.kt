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
import androidx.test.espresso.intent.Intents.intended
import androidx.test.espresso.intent.Intents.intending
import androidx.test.espresso.intent.matcher.IntentMatchers.hasAction
import androidx.test.espresso.intent.matcher.IntentMatchers.hasData
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
            val loaded = CountDownLatch(1)
            scenario.onActivity { activity ->
                activity.findViewById<WebView>(R.id.web_client).apply {
                    webViewClient = object : WebViewClient() {
                        override fun onPageFinished(view: WebView, url: String) {
                            loaded.countDown()
                        }
                    }
                    loadDataWithBaseURL(
                        "https://untrusted.example/",
                        "<html><body>untrusted</body></html>",
                        "text/html",
                        Charsets.UTF_8.name(),
                        null,
                    )
                }
            }

            assertTrue(
                "Unapproved-origin document did not load",
                loaded.await(5, TimeUnit.SECONDS),
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
                window.__yaNativeFrameResult = "pending";
                const frame = document.createElement("iframe");
                frame.srcdoc = "<html><body>frame</body></html>";
                frame.onload = () => {
                  const channel = frame.contentWindow.yaNative;
                  if (!channel) {
                    window.__yaNativeFrameResult = "absent";
                    return;
                  }
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
                  }, 250);
                };
                document.body.appendChild(frame);
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
            scenario.onActivity { activity ->
                activity.findViewById<WebView>(R.id.web_client).loadUrl(
                    "https://appassets.androidplatform.net/debug-streaming.html",
                )
            }
            awaitJavaScript(
                scenario,
                "window.location.pathname",
                "\"/debug-streaming.html\"",
            )
            scenario.onActivity { activity ->
                assertTrue(activity.findViewById<WebView>(R.id.web_client).canGoBack())
            }

            scenario.onActivity { activity ->
                activity.onBackPressedDispatcher.onBackPressed()
            }

            awaitJavaScript(
                scenario,
                """
                window.location.pathname === "/debug-streaming.html"
                  ? "waiting"
                  : "returned"
                """.trimIndent(),
                "\"returned\"",
            )
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

                intended(hasAction(Intent.ACTION_VIEW))
                intended(hasData("https://example.com/android-contract"))
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

    private fun awaitJavaScriptOneOf(
        scenario: ActivityScenario<WebClientActivity>,
        script: String,
        expected: Set<String>,
    ) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        var actual = ""
        while (System.nanoTime() < deadline) {
            actual = evaluateJavaScript(scenario, script)
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
