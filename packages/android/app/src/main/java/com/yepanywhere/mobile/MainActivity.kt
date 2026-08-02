package com.yepanywhere.mobile

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import com.yepanywhere.mobile.ui.theme.YepAnywhereTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            YepAnywhereTheme {
                ShellPlaceholder()
            }
        }
    }
}

@Composable
private fun ShellPlaceholder() {
    Surface(
        modifier = Modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.background,
    ) {
        Box(contentAlignment = Alignment.Center) {
            Text(
                text = "Yep Anywhere",
                style = MaterialTheme.typography.headlineMedium,
            )
        }
    }
}
