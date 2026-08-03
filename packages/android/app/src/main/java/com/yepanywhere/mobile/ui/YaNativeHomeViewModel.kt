package com.yepanywhere.mobile.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.yepanywhere.mobile.YepAnywhereApplication
import com.yepanywhere.mobile.connection.YaConnectionLease
import com.yepanywhere.mobile.connection.YaConnectionPhase
import com.yepanywhere.mobile.connection.YaConnectionState
import com.yepanywhere.mobile.connection.YaSubscription
import com.yepanywhere.mobile.profiles.YaPairedServerProfile
import com.yepanywhere.mobile.profiles.YaServerRoute
import com.yepanywhere.mobile.profiles.YaServerRemovalCoordinator
import com.yepanywhere.mobile.profiles.YaServerRemovalOutcome
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

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
}

data class YaNativeServerState(
    val profile: YaPairedServerProfile,
    val included: Boolean,
    val connection: YaConnectionState = YaConnectionState(YaConnectionPhase.IDLE),
    val sessions: List<YaSessionSummary> = emptyList(),
    val sessionsLoading: Boolean = false,
    val sessionLoadFailed: Boolean = false,
    val hostIcon: String? = null,
)

data class YaSourcedSession(
    val profileId: String,
    val serverUsername: String,
    val serverIcon: String?,
    val session: YaSessionSummary,
) {
    val key: String = "$profileId:${session.id}"
}

enum class YaRemovalPromptKind {
    SERVER_RECORD_MAY_REMAIN,
    SERVER_ALREADY_UNREGISTERED,
}

data class YaRemovalPrompt(
    val profileId: String,
    val kind: YaRemovalPromptKind,
)

data class YaNativeHomeState(
    val profiles: List<YaPairedServerProfile> = emptyList(),
    val includedProfileIds: Set<String> = emptySet(),
    val filterProfileId: String? = null,
    val servers: Map<String, YaNativeServerState> = emptyMap(),
    val actionInProgress: Boolean = false,
    val error: YaNativeUiError? = null,
    val removalPrompt: YaRemovalPrompt? = null,
) {
    val includedProfiles: List<YaPairedServerProfile>
        get() = profiles.filter { it.id in includedProfileIds }

    val sourcedSessions: List<YaSourcedSession>
        get() {
            val visibleIds = filterProfileId?.let(::setOf) ?: includedProfileIds
            return servers.values
                .asSequence()
                .filter { it.profile.id in visibleIds }
                .flatMap { source ->
                    source.sessions.asSequence().map { session ->
                        YaSourcedSession(
                            profileId = source.profile.id,
                            serverUsername = source.profile.username,
                            serverIcon = source.hostIcon,
                            session = session,
                        )
                    }
                }
                .sortedByDescending { it.session.updatedAt }
                .toList()
        }
}

class YaNativeHomeViewModel(application: Application) : AndroidViewModel(application) {
    private val runtime = (application as YepAnywhereApplication).nativeRuntime
    private val store = runtime.pairedServers
    private val mutableState = MutableStateFlow(YaNativeHomeState())
    private val visible = MutableStateFlow(false)
    private val connectionRevision = MutableStateFlow(0L)
    private val actionRunning = AtomicBoolean(false)
    private val activeLeases = mutableMapOf<String, ActiveSource>()
    private val removal = YaServerRemovalCoordinator(store::forget)

    val state: StateFlow<YaNativeHomeState> = mutableState.asStateFlow()

    init {
        viewModelScope.launch {
            store.listState.collect { listState ->
                val sources = listState.profiles.associate { profile ->
                    val previous = mutableState.value.servers[profile.id]
                    profile.id to (previous?.copy(
                        profile = profile,
                        included = profile.id in listState.includedProfileIds,
                    ) ?: YaNativeServerState(
                        profile = profile,
                        included = profile.id in listState.includedProfileIds,
                    ))
                }
                val filter = mutableState.value.filterProfileId
                    ?.takeIf { it in listState.includedProfileIds }
                mutableState.value = mutableState.value.copy(
                    profiles = listState.profiles,
                    includedProfileIds = listState.includedProfileIds,
                    filterProfileId = filter,
                    servers = sources,
                )
            }
        }
        viewModelScope.launch {
            combine(store.listState, visible, connectionRevision) { list, isVisible, revision ->
                BindingKey(
                    profileIds = if (isVisible) list.includedProfileIds.sorted() else emptyList(),
                    revision = revision,
                )
            }.distinctUntilChanged().collectLatest { key ->
                bindProfiles(key.profileIds)
            }
        }
    }

    fun setVisible(isVisible: Boolean) {
        visible.value = isVisible
    }

    fun setFilter(profileId: String?) {
        if (profileId != null && profileId !in mutableState.value.includedProfileIds) return
        mutableState.value = mutableState.value.copy(filterProfileId = profileId)
    }

    fun setIncluded(profileId: String, included: Boolean) {
        viewModelScope.launch {
            runCatching { store.setIncluded(profileId, included) }
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

    fun reauthenticate(profileId: String, password: String) {
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

    fun refreshSessions(profileId: String? = mutableState.value.filterProfileId) {
        val ids = profileId?.let(::listOf) ?: mutableState.value.includedProfileIds.toList()
        ids.forEach { id ->
            activeLeases[id]?.let { active ->
                viewModelScope.launch { loadSessions(id, active) }
            }
        }
    }

    fun removeProfile(profileId: String) {
        runAction {
            val profile = mutableState.value.profiles.firstOrNull { it.id == profileId }
                ?: return@runAction
            val active = activeLeases[profileId]
            val online = mutableState.value.servers[profileId]
                ?.connection
                ?.phase == YaConnectionPhase.CONNECTED
            val unregister: (suspend (String) -> Unit)? = if (active != null && online) {
                { clientId ->
                    active.lease.request("DELETE", "/security/clients/$clientId")
                    Unit
                }
            } else {
                null
            }
            when (removal.remove(profile, unregister)) {
                YaServerRemovalOutcome.COMPLETE -> clearRemovalPrompt()
                YaServerRemovalOutcome.NEEDS_FORGET_ANYWAY -> {
                    mutableState.value = mutableState.value.copy(
                        removalPrompt = YaRemovalPrompt(
                            profileId,
                            YaRemovalPromptKind.SERVER_RECORD_MAY_REMAIN,
                        ),
                    )
                }
                YaServerRemovalOutcome.NEEDS_LOCAL_CLEANUP -> {
                    mutableState.value = mutableState.value.copy(
                        removalPrompt = YaRemovalPrompt(
                            profileId,
                            YaRemovalPromptKind.SERVER_ALREADY_UNREGISTERED,
                        ),
                    )
                }
            }
        }
    }

    fun forgetAnyway(profileId: String) {
        runAction {
            when (removal.forgetAnyway(profileId)) {
                YaServerRemovalOutcome.COMPLETE -> clearRemovalPrompt()
                else -> setError(YaNativeUiError.CONNECTION_FAILED)
            }
        }
    }

    fun clearRemovalPrompt() {
        mutableState.value = mutableState.value.copy(removalPrompt = null)
    }

    fun retryConnections() {
        connectionRevision.value += 1
    }

    fun clearError() {
        mutableState.value = mutableState.value.copy(error = null)
    }

    private suspend fun bindProfiles(profileIds: List<String>): Unit = coroutineScope {
        profileIds.forEach { profileId ->
            launch { bindProfile(profileId) }
        }
        awaitCancellation()
    }

    private suspend fun bindProfile(profileId: String) {
        val manager = runtime.connectionManager(profileId)
        val lease = try {
            manager.acquire()
        } catch (error: CancellationException) {
            throw error
        } catch (_: Throwable) {
            updateSource(profileId) {
                it.copy(connection = YaConnectionState(YaConnectionPhase.FAILED))
            }
            return
        }
        val active = ActiveSource(lease)
        activeLeases[profileId] = active
        try {
            coroutineScope {
                launch {
                    manager.state.collect { connection ->
                        if (activeLeases[profileId] === active) {
                            updateSource(profileId) { it.copy(connection = connection) }
                        }
                    }
                }
                launch { loadSessions(profileId, active) }
                launch { loadHostIdentity(profileId, active) }
                launch { watchActivity(profileId, active) }
                awaitCancellation()
            }
        } finally {
            if (activeLeases[profileId] === active) activeLeases.remove(profileId)
            withContext(NonCancellable) { lease.releaseAndAwait() }
            updateSource(profileId) {
                it.copy(
                    connection = YaConnectionState(YaConnectionPhase.IDLE),
                    sessionsLoading = false,
                    hostIcon = null,
                )
            }
        }
    }

    private suspend fun loadSessions(profileId: String, active: ActiveSource) {
        if (activeLeases[profileId] !== active) return
        updateSource(profileId) {
            it.copy(sessionsLoading = true, sessionLoadFailed = false)
        }
        try {
            val response = active.lease.request("GET", "/sessions?limit=50")
            val sessions = YaSessionSummary.parseResponse(response.body)
            if (activeLeases[profileId] === active) {
                updateSource(profileId) {
                    it.copy(
                        sessions = sessions,
                        sessionsLoading = false,
                        sessionLoadFailed = false,
                    )
                }
            }
        } catch (error: CancellationException) {
            throw error
        } catch (_: Throwable) {
            if (activeLeases[profileId] === active) {
                updateSource(profileId) {
                    it.copy(sessionsLoading = false, sessionLoadFailed = true)
                }
            }
        }
    }

    private suspend fun loadHostIdentity(profileId: String, active: ActiveSource) {
        try {
            val version = active.lease.request("GET", "/version").body as? JSONObject ?: return
            val capabilities = version.optJSONArray("capabilities") ?: return
            val supported = (0 until capabilities.length()).any { index ->
                capabilities.optString(index) == HOST_IDENTITY_CAPABILITY
            }
            if (!supported) return
            val response = active.lease.request("GET", "/settings").body as? JSONObject ?: return
            val icon = response.optJSONObject("settings")
                ?.optJSONObject("hostIdentity")
                ?.optString("icon")
                ?.trim()
                ?.takeIf(String::isNotEmpty)
            if (activeLeases[profileId] === active) {
                updateSource(profileId) { it.copy(hostIcon = icon) }
            }
        } catch (error: CancellationException) {
            throw error
        } catch (_: Throwable) {
            // Host identity is optional; source connection and sessions remain usable.
        }
    }

    private suspend fun watchActivity(profileId: String, active: ActiveSource) {
        var subscription: YaSubscription? = null
        var refreshJob: Job? = null
        try {
            subscription = active.lease.subscribe(channel = "activity")
            subscription.events.collect {
                if (refreshJob?.isActive != true) {
                    refreshJob = viewModelScope.launch {
                        delay(ACTIVITY_REFRESH_DELAY_MS)
                        loadSessions(profileId, active)
                    }
                }
            }
        } catch (error: CancellationException) {
            throw error
        } catch (_: Throwable) {
            // The initial request and manual refresh remain useful without activity events.
        } finally {
            refreshJob?.cancel()
            subscription?.close()
        }
    }

    private fun updateSource(
        profileId: String,
        transform: (YaNativeServerState) -> YaNativeServerState,
    ) {
        val current = mutableState.value
        val source = current.servers[profileId] ?: return
        mutableState.value = current.copy(
            servers = current.servers + (profileId to transform(source)),
        )
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

    private data class ActiveSource(val lease: YaConnectionLease)
    private data class BindingKey(val profileIds: List<String>, val revision: Long)

    companion object {
        private const val HOST_IDENTITY_CAPABILITY = "host-identity"
        private const val ACTIVITY_REFRESH_DELAY_MS = 250L
    }
}
