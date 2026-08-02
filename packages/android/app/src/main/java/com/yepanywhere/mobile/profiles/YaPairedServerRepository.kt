package com.yepanywhere.mobile.profiles

interface YaPairedServerRepository {
    suspend fun snapshot(profileId: String): YaPairedServerSnapshot?

    suspend fun upsert(
        profile: YaPairedServerProfile,
        resumeCredential: YaStoredResumeCredential? = null,
        select: Boolean = false,
    )

    suspend fun clearCredential(profileId: String)

    suspend fun updateSecurityClientBinding(
        profileId: String,
        binding: YaSecurityClientBinding,
    ) {
        val current = checkNotNull(snapshot(profileId)) {
            "Cannot update an unknown profile"
        }
        upsert(
            profile = current.profile.copy(securityClient = binding),
            resumeCredential = current.resumeCredential,
        )
    }

    suspend fun markSecurityClientRevoked(profileId: String, clientId: String) {
        updateSecurityClientBinding(profileId, YaSecurityClientBinding.revoked(clientId))
        clearCredential(profileId)
    }

    suspend fun recordSuccessfulAuthentication(
        profileId: String,
        routeId: String,
        resumeCredential: YaStoredResumeCredential,
        connectedAtEpochMs: Long,
    )
}
