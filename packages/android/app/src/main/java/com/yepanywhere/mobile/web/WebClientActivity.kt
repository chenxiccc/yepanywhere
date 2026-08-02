package com.yepanywhere.mobile.web

import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewFeature
import androidx.webkit.WebSettingsCompat
import com.yepanywhere.mobile.BuildConfig
import com.yepanywhere.mobile.R

class WebClientActivity : ComponentActivity() {
    private val config by lazy(WebClientConfig::fromBuild)
    private var webView: WebView? = null
    private var nativeHost: YaNativeMessageHost? = null
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private var mainFrameFailed = false

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val callback = fileChooserCallback
        fileChooserCallback = null
        callback?.onReceiveValue(
            WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data),
        )
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.rgb(24, 24, 24))
        }
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }

        val clientView = createWebView()
        val errorView = createErrorView(clientView)
        root.addView(
            clientView,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        root.addView(
            errorView,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        setContentView(root)

        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    val current = webView
                    if (current?.canGoBack() == true) {
                        current.goBack()
                    } else {
                        finish()
                    }
                }
            },
        )

        clientView.webViewClient = createWebViewClient(errorView)
        clientView.loadUrl(config.startUrl)
    }

    @Suppress("SetJavaScriptEnabled")
    private fun createWebView(): WebView {
        val view = WebView(this).apply {
            id = R.id.web_client
            setBackgroundColor(Color.rgb(24, 24, 24))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            settings.javaScriptCanOpenWindowsAutomatically = false
            settings.setSupportMultipleWindows(false)
            settings.builtInZoomControls = false
            settings.displayZoomControls = false
            if (WebViewFeature.isFeatureSupported(WebViewFeature.SAFE_BROWSING_ENABLE)) {
                WebSettingsCompat.setSafeBrowsingEnabled(settings, true)
            }
            CookieManager.getInstance().setAcceptCookie(true)
            CookieManager.getInstance().setAcceptThirdPartyCookies(this, false)
            webChromeClient = object : WebChromeClient() {
                override fun onShowFileChooser(
                    webView: WebView,
                    filePathCallback: ValueCallback<Array<Uri>>,
                    fileChooserParams: FileChooserParams,
                ): Boolean {
                    fileChooserCallback?.onReceiveValue(null)
                    fileChooserCallback = filePathCallback
                    return try {
                        fileChooserLauncher.launch(fileChooserParams.createIntent())
                        true
                    } catch (_: ActivityNotFoundException) {
                        fileChooserCallback = null
                        filePathCallback.onReceiveValue(null)
                        false
                    }
                }
            }
            setDownloadListener { url, _, _, _, _ ->
                openExternal(url)
            }
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        nativeHost = YaNativeMessageHost.install(view, config)
        webView = view
        return view
    }

    private fun createErrorView(clientView: WebView): View {
        return LinearLayout(this).apply errorView@ {
            id = R.id.web_error
            visibility = View.GONE
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(48, 48, 48, 48)
            setBackgroundColor(Color.rgb(24, 24, 24))

            addView(TextView(context).apply {
                text = getString(R.string.web_client_unavailable)
                setTextColor(Color.WHITE)
                textSize = 18f
                gravity = Gravity.CENTER
            })
            addView(Button(context).apply {
                text = getString(R.string.retry)
                setOnClickListener {
                    this@errorView.visibility = View.GONE
                    clientView.reload()
                }
            })
        }
    }

    private fun createWebViewClient(errorView: View): WebViewClient {
        val assetLoader = if (config.bundled) {
            WebViewAssetLoader.Builder()
                .addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(this))
                .build()
        } else {
            null
        }

        return object : WebViewClient() {
            override fun onPageStarted(
                view: WebView,
                url: String,
                favicon: Bitmap?,
            ) {
                mainFrameFailed = false
                errorView.visibility = View.GONE
                nativeHost?.onDocumentChanged()
            }

            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? {
                if (
                    assetLoader != null &&
                    request.isForMainFrame &&
                    WebClientNavigation.decide(request.url.toString(), config.origin) ==
                    NavigationDecision.ALLOW_IN_APP &&
                    request.url.lastPathSegment?.contains('.') != true
                ) {
                    return assetLoader.shouldInterceptRequest(
                        Uri.parse("${config.origin}/index.html"),
                    )
                }
                return assetLoader?.shouldInterceptRequest(request.url)
            }

            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean {
                return when (
                    WebClientNavigation.decide(request.url.toString(), config.origin)
                ) {
                    NavigationDecision.ALLOW_IN_APP -> false
                    NavigationDecision.OPEN_EXTERNALLY -> {
                        openExternal(request.url.toString())
                        true
                    }
                    NavigationDecision.BLOCK -> true
                }
            }

            override fun onPageFinished(view: WebView, url: String) {
                if (!mainFrameFailed) {
                    errorView.visibility = View.GONE
                }
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError,
            ) {
                if (request.isForMainFrame) {
                    mainFrameFailed = true
                    errorView.visibility = View.VISIBLE
                }
            }

            override fun onReceivedHttpError(
                view: WebView,
                request: WebResourceRequest,
                errorResponse: WebResourceResponse,
            ) {
                if (request.isForMainFrame) {
                    mainFrameFailed = true
                    errorView.visibility = View.VISIBLE
                }
            }

            override fun onRenderProcessGone(
                view: WebView,
                detail: RenderProcessGoneDetail,
            ): Boolean {
                nativeHost?.destroy()
                nativeHost = null
                webView = null
                view.destroy()
                recreate()
                return true
            }
        }
    }

    private fun openExternal(url: String) {
        if (
            WebClientNavigation.decide(url, config.origin) !=
            NavigationDecision.OPEN_EXTERNALLY
        ) {
            return
        }
        try {
            startActivity(
                Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                    addCategory(Intent.CATEGORY_BROWSABLE)
                },
            )
        } catch (_: ActivityNotFoundException) {
            // The navigation remains blocked inside the privileged WebView.
        }
    }

    override fun onDestroy() {
        fileChooserCallback?.onReceiveValue(null)
        fileChooserCallback = null
        nativeHost?.destroy()
        nativeHost = null
        webView?.let { view ->
            (view.parent as? ViewGroup)?.removeView(view)
            view.stopLoading()
            view.destroy()
        }
        webView = null
        super.onDestroy()
    }
}
