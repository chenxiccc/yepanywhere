package com.yepanywhere.mobile.profiles

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import java.io.File
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class YaPairedServerStoreTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @Test
    fun `missing policy includes existing profiles and explicit choices persist`() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val store = YaPairedServerStore(
            dataStore = PreferenceDataStoreFactory.create(scope = scope) {
                File(temporaryFolder.root, "paired.preferences_pb")
            },
            cipher = UnusedCipher,
            ownedScope = scope,
        )
        try {
            val alpha = profile("alpha")
            val beta = profile("beta")
            store.upsert(alpha, select = true)
            store.upsert(beta)

            assertEquals(setOf(alpha.id, beta.id), store.includedProfileIds.first())

            store.setIncluded(alpha.id, included = false)
            assertEquals(setOf(beta.id), store.includedProfileIds.first())

            store.upsert(alpha.copy(label = "alpha updated"))
            assertEquals(setOf(beta.id), store.includedProfileIds.first())

            val gamma = profile("gamma")
            store.upsert(gamma)
            assertEquals(setOf(beta.id, gamma.id), store.includedProfileIds.first())

            store.forget(beta.id)
            assertEquals(setOf(gamma.id), store.includedProfileIds.first())
            assertEquals(
                listOf(alpha.id, gamma.id).toSet(),
                store.listState.first().profiles.map(YaPairedServerProfile::id).toSet(),
            )
        } finally {
            store.close()
        }
    }

    @Test
    fun `policy codec preserves explicit empty and defaults malformed data to all`() {
        val alpha = UUID.randomUUID().toString()
        val beta = UUID.randomUUID().toString()
        val known = setOf(alpha, beta)

        assertEquals(known, YaIncludedServerPolicy.decode(null, known))
        assertEquals(emptySet<String>(), YaIncludedServerPolicy.decode(
            YaIncludedServerPolicy.encode(emptySet()),
            known,
        ))
        assertEquals(known, YaIncludedServerPolicy.decode("not json", known))
        assertEquals(
            setOf(alpha),
            YaIncludedServerPolicy.decode(
                YaIncludedServerPolicy.encode(setOf(alpha, UUID.randomUUID().toString())),
                known,
            ),
        )
    }

    private fun profile(label: String): YaPairedServerProfile = YaPairedServerProfile.create(
        label = label,
        username = label,
        route = YaServerRoute.relay("wss://relay.example/ws", "$label-server"),
        nowEpochMs = 1_000,
    )

    private object UnusedCipher : YaResumeCredentialCipher {
        override fun encrypt(profileId: String, plaintext: ByteArray): String = error("Not used")
        override fun decrypt(profileId: String, envelope: String): ByteArray? = error("Not used")
    }
}
