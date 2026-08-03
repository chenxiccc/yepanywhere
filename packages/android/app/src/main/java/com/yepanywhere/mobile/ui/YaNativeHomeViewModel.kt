package com.yepanywhere.mobile.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.yepanywhere.mobile.YepAnywhereApplication
import com.yepanywhere.mobile.connection.YaConnectionLease
import com.yepanywhere.mobile.connection.YaConnectionPhase
import com.yepanywhere.mobile.connection.YaConnectionState
import com.yepanywhere.mobile.profiles.YaPairedServerProfile
import com.yepanywhere.mobile.profiles.YaServerRoute
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

enum class YaPairingRouteKind {
    DIRECT,
    RELAY,
}

data class YaPairingInput(
    val username: String,
    val password: String,
    val routeKind: YaPairingRouteKind = YaPairingRouteKind.RELAY,
    val relayWebsocketUrl: String = "",
    val directWebsocketUrl: String = "",
)

// Keep aligned with @yep-anywhere/shared DEFAULT_RELAY_URL.
internal const val DEFAULT_RELAY_WEBSOCKET_URL = "wss://relay.yepanywhere.com/ws"

internal fun YaPairingInput.normalizedUsername(): String = when (routeKind) {
    YaPairingRouteKind.RELAY -> username.trim().lowercase(Locale.ROOT)
    YaPairingRouteKind.DIRECT -> username.trim()
}

internal fun YaPairingInput.resolveRoute(username: String): YaServerRoute = when (routeKind) {
    YaPairingRouteKind.RELAY -> YaServerRoute.relay(
        websocketUrl = relayWebsocketUrl.trim().ifEmpty { DEFAULT_RELAY_WEBSOCKET_URL },
        relayTarget = username,
    )
    YaPairingRouteKind.DIRECT -> YaServerRoute.direct(directWebsocketUrl.trim())
}

enum class YaNativeUiError {
    INVALID_SERVER_DETAILS,
    AUTHENTICATION_FAILED,
    CONNECTION_FAILED,
    SESSION_LOAD_FAILED,
}

data class YaNativeHomeState(
    val profiles: List<YaPairedServerProfile> = emptyList(),
    val selectedProfileId: String? = null,
    val connection: YaConnectionState = YaConnectionState(YaConnectionPhase.IDLE),
    val sessions: List<YaSessionSummary> = emptyList(),
    val sessionsLoading: Boolean = false,
    val actionInProgress: Boolean = false,
    val error: YaNativeUiError? = null,
)

class YaNativeHomeViewModel(application: Application) : AndroidViewModel(application) {
    private val runtime = (application as YepAnywhereApplication).nativeRuntime
    private val store = runtime.pairedServers
    private val mutableState = MutableStateFlow(YaNativeHomeState())
    private val visible = MutableStateFlow(false)
    private val connectionRevision = MutableStateFlow(0L)
    private val actionRunning = AtomicBoolean(false)
    private var activeLease: YaConnectionLease? = null
    private var loadJob: Job? = null

    val state: StateFlow<YaNativeHomeState> = mutableState.asStateFlow()

    init {
        viewModelScope.launch {
            combine(store.profiles, store.selectedProfileId) { profiles, selected ->
                profiles to selected
            }.collect { (profiles, selected) ->
                val validSelected = selected?.takeIf { id -> profiles.any { it.id == id } }
                mutableState.value = mutableState.value.copy(
                    profiles = profiles,
                    selectedProfileId = validSelected,
                )
                if (validSelected == null && profiles.isNotEmpty()) {
                    store.select(profiles.first().id)
                }
            }
        }
        viewModelScope.launch {
            combine(
                store.selectedProfileId,
                visible,
                connectionRevision,
            ) { selected, isVisible, revision ->
                BindingKey(selected.takeIf { isVisible }, revision)
            }.distinctUntilChanged().collectLatest { key ->
                bindProfile(key.profileId)
            }
        }
    }

    fun setVisible(isVisible: Boolean) {
        visible.value = isVisible
    }

    fun selectProfile(profileId: String) {
        viewModelScope.launch {
            runCatching { store.select(profileId) }
                .onFailure { setError(YaNativeUiError.CONNECTION_FAILED) }
        }
    }

    fun pair(input: YaPairingInput) {
        runAction {
            val username = input.normalizedUsername()
            if (username.isBlank() || input.password.isEmpty()) {
                setError(YaNativeUiError.INVALID_SERVER_DETAILS)
                return@runAction
            }
            val route = try {
                input.resolveRoute(username)
            } catch (_: IllegalArgumentException) {
                setError(YaNativeUiError.INVALID_SERVER_DETAILS)
                return@runAction
            }
            try {
                runtime.pairing.pair(
                    label = username,
                    username = username,
                    password = input.password,
                    route = route,
                )
            } catch (error: CancellationException) {
                throw error
            } catch (_: Throwable) {
                setError(YaNativeUiError.AUTHENTICATION_FAILED)
            }
        }
    }

    fun reauthenticate(password: String) {
        val profileId = mutableState.value.selectedProfileId ?: return
        runAction {
            if (password.isEmpty()) {
                setError(YaNativeUiError.INVALID_SERVER_DETAILS)
                return@runAction
            }
            try {
                runtime.pairing.reauthenticate(profileId, password)
                connectionRevision.value += 1
            } catch (error: CancellationException) {
                throw error
            } catch (_: Throwable) {
                setError(YaNativeUiError.AUTHENTICATION_FAILED)
            }
        }
    }

    fun refreshSessions() {
        val lease = activeLease ?: return
        loadJob?.cancel()
        loadJob = viewModelScope.launch { loadSessions(lease) }
    }

    fun forgetSelectedProfile() {
        val profileId = mutableState.value.selectedProfileId ?: return
        runAction {
            try {
                store.forget(profileId)
            } catch (error: CancellationException) {
                throw error
            } catch (_: Throwable) {
                setError(YaNativeUiError.CONNECTION_FAILED)
            }
        }
    }

    fun clearError() {
        mutableState.value = mutableState.value.copy(error = null)
    }

    private suspend fun bindProfile(profileId: String?) {
        activeLease = null
        loadJob?.cancel()
        loadJob = null
        mutableState.value = mutableState.value.copy(
            connection = YaConnectionState(YaConnectionPhase.IDLE),
            sessions = emptyList(),
            sessionsLoading = false,
        )
        if (profileId == null) return

        val manager = runtime.connectionManager(profileId)
        val lease = manager.acquire()
        activeLease = lease
        val stateJob = viewModelScope.launch {
            manager.state.collect { connection ->
                if (activeLease === lease) {
                    mutableState.value = mutableState.value.copy(connection = connection)
                }
            }
        }
        loadJob = viewModelScope.launch { loadSessions(lease) }
        try {
            awaitCancellation()
        } finally {
            loadJob?.cancel()
            if (activeLease === lease) activeLease = null
            stateJob.cancel()
            withContext(NonCancellable) { lease.releaseAndAwait() }
        }
    }

    private suspend fun loadSessions(lease: YaConnectionLease) {
        if (activeLease !== lease) return
        mutableState.value = mutableState.value.copy(
            sessionsLoading = true,
            error = null,
        )
        try {
            val response = lease.request("GET", "/sessions?limit=50")
            val sessions = YaSessionSummary.parseResponse(response.body)
            if (activeLease === lease) {
                mutableState.value = mutableState.value.copy(
                    sessions = sessions,
                    sessionsLoading = false,
                )
            }
        } catch (error: CancellationException) {
            throw error
        } catch (_: Throwable) {
            if (activeLease === lease) {
                val phase = mutableState.value.connection.phase
                mutableState.value = mutableState.value.copy(
                    sessionsLoading = false,
                    error = if (phase == YaConnectionPhase.REAUTHENTICATION_REQUIRED) {
                        null
                    } else {
                        YaNativeUiError.SESSION_LOAD_FAILED
                    },
                )
            }
        }
    }

    private fun runAction(block: suspend () -> Unit) {
        if (!actionRunning.compareAndSet(false, true)) return
        mutableState.value = mutableState.value.copy(
            actionInProgress = true,
            error = null,
        )
        viewModelScope.launch {
            try {
                block()
            } finally {
                actionRunning.set(false)
                mutableState.value = mutableState.value.copy(actionInProgress = false)
            }
        }
    }

    private fun setError(error: YaNativeUiError) {
        mutableState.value = mutableState.value.copy(error = error)
    }

    private data class BindingKey(val profileId: String?, val revision: Long)
}
