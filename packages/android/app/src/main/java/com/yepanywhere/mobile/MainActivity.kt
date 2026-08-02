package com.yepanywhere.mobile

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.core.net.toUri
import com.yepanywhere.mobile.links.AppLinkDestination
import com.yepanywhere.mobile.ui.YaNativeHomeScreen
import com.yepanywhere.mobile.ui.YaNativeHomeViewModel
import com.yepanywhere.mobile.ui.theme.YepAnywhereTheme
import com.yepanywhere.mobile.web.WebClientActivity
import com.yepanywhere.mobile.web.WebClientConfig

class MainActivity : ComponentActivity() {
    private val homeViewModel by viewModels<YaNativeHomeViewModel>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            YepAnywhereTheme {
                YaNativeHomeScreen(
                    viewModel = homeViewModel,
                    openWebClient = ::openWebClient,
                )
            }
        }
        if (savedInstanceState == null && intent.dataString != null) {
            openWebClient()
        }
    }

    override fun onStart() {
        super.onStart()
        homeViewModel.setVisible(true)
    }

    override fun onStop() {
        homeViewModel.setVisible(false)
        super.onStop()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        openWebClient()
    }

    private fun openWebClient() {
        val requestedUrl = AppLinkDestination.toWebClientUrl(
            intent.dataString,
            WebClientConfig.fromBuild().startUrl,
        )
        intent.data = null
        startActivity(
            Intent(this, WebClientActivity::class.java).apply {
                if (requestedUrl != null) {
                    data = requestedUrl.toUri()
                }
            },
        )
    }
}
