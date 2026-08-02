package com.yepanywhere.mobile

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import com.yepanywhere.mobile.links.AppLinkDestination
import com.yepanywhere.mobile.ui.theme.YepAnywhereTheme
import com.yepanywhere.mobile.web.WebClientActivity
import com.yepanywhere.mobile.web.WebClientConfig

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            YepAnywhereTheme {
                LauncherScreen(::openWebClient)
            }
        }
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

@Composable
private fun LauncherScreen(openWebClient: () -> Unit) {
    var openedAutomatically by rememberSaveable { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        if (!openedAutomatically) {
            openedAutomatically = true
            openWebClient()
        }
    }

    Surface(
        modifier = Modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.background,
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Text(
                text = stringResource(R.string.app_name),
                style = MaterialTheme.typography.headlineMedium,
            )
            Button(
                modifier = Modifier.padding(top = 20.dp),
                onClick = openWebClient,
            ) {
                Text(stringResource(R.string.open_full_app))
            }
        }
    }
}
