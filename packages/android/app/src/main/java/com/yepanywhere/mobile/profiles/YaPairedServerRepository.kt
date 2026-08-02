package com.yepanywhere.mobile.profiles

interface YaPairedServerRepository {
    suspend fun snapshot(profileId: String): YaPairedServerSnapshot?

    suspend fun upsert(
        profile: YaPairedServerProfile,
        resumeCredential: YaStoredResumeCredential? = null,
        select: Boolean = false,
    )

    suspend fun clearCredential(profileId: String)

    suspend fun recordSuccessfulAuthentication(
        profileId: String,
        routeId: String,
        resumeCredential: YaStoredResumeCredential,
        connectedAtEpochMs: Long,
    )
}
