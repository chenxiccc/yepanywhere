package com.yepanywhere.mobile.web

import android.webkit.WebView
import android.webkit.WebViewClient
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
