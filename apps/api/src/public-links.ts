export const PUBLIC_REPOSITORY_SLUG = "agentry-sh/agentry" as const;
export const PUBLIC_ORGANIZATION_URL = "https://github.com/agentry-sh" as const;
export const PUBLIC_REPOSITORY_URL =
  `https://github.com/${PUBLIC_REPOSITORY_SLUG}` as const;
export const PUBLIC_REPOSITORY_BLOB_ROOT =
  `${PUBLIC_REPOSITORY_URL}/blob/main` as const;
export const PUBLIC_REPOSITORY_RAW_ROOT =
  `https://raw.githubusercontent.com/${PUBLIC_REPOSITORY_SLUG}/main` as const;

// GitHub is the canonical home for authored prose. Machine-facing pointers use
// raw Markdown; browser/legal links use GitHub's rendered file view.
export const PUBLIC_INSTALL_DOC_URL =
  `${PUBLIC_REPOSITORY_RAW_ROOT}/INSTALL.md` as const;
export const PUBLIC_AGENT_REFERENCE_URL =
  `${PUBLIC_REPOSITORY_RAW_ROOT}/AGENTRY.md` as const;
export const PUBLIC_SKILL_URL =
  `${PUBLIC_REPOSITORY_RAW_ROOT}/plugins/agentry/skills/agentry/SKILL.md` as const;
export const PUBLIC_INSTALL_GUIDE_URL =
  `${PUBLIC_REPOSITORY_BLOB_ROOT}/INSTALL.md` as const;
export const PUBLIC_PRIVACY_URL =
  `${PUBLIC_REPOSITORY_BLOB_ROOT}/PRIVACY.md` as const;
export const PUBLIC_TERMS_URL =
  `${PUBLIC_REPOSITORY_BLOB_ROOT}/TERMS.md` as const;
export const PUBLIC_PRICING_URL =
  `${PUBLIC_REPOSITORY_BLOB_ROOT}/PRICING.md` as const;

export const AUTH_ORIGIN = "https://auth.agentry.sh" as const;
export const AUTH_BILLING_SUCCESS_URL =
  `${AUTH_ORIGIN}/billing/success?session_id={CHECKOUT_SESSION_ID}` as const;

export const PUBLIC_INSTALL_REVIEW_ANCHOR =
  `${PUBLIC_INSTALL_GUIDE_URL}#4-review-and-approve-the-exact-plan` as const;
export const PUBLIC_INSTALL_PROOF_ANCHOR =
  `${PUBLIC_INSTALL_GUIDE_URL}#5-apply-approved-telemetry-changes-directly-to-posthog` as const;
export const PUBLIC_INSTALL_VERIFY_ANCHOR =
  `${PUBLIC_INSTALL_GUIDE_URL}#6-prove-the-deployed-result` as const;
