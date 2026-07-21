import { describe, expect, it } from "vitest";
import {
  AUTH_BILLING_SUCCESS_URL,
  AUTH_ORIGIN,
  PUBLIC_AGENT_REFERENCE_URL,
  PUBLIC_INSTALL_DOC_URL,
  PUBLIC_INSTALL_GUIDE_URL,
  PUBLIC_INSTALL_PROOF_ANCHOR,
  PUBLIC_INSTALL_REVIEW_ANCHOR,
  PUBLIC_INSTALL_VERIFY_ANCHOR,
  PUBLIC_ORGANIZATION_URL,
  PUBLIC_PRICING_URL,
  PUBLIC_PRIVACY_URL,
  PUBLIC_REPOSITORY_URL,
  PUBLIC_SKILL_URL,
  PUBLIC_TERMS_URL,
} from "../src/public-links.js";

describe("canonical public links", () => {
  it("uses the agentry organization repository for authored public material", () => {
    expect(PUBLIC_ORGANIZATION_URL).toBe("https://github.com/agentry-sh");
    expect(PUBLIC_REPOSITORY_URL).toBe("https://github.com/agentry-sh/agentry");
    expect(PUBLIC_INSTALL_DOC_URL).toBe(
      "https://raw.githubusercontent.com/agentry-sh/agentry/main/INSTALL.md",
    );
    expect(PUBLIC_AGENT_REFERENCE_URL).toBe(
      "https://raw.githubusercontent.com/agentry-sh/agentry/main/AGENTRY.md",
    );
    expect(PUBLIC_SKILL_URL).toBe(
      "https://raw.githubusercontent.com/agentry-sh/agentry/main/plugins/agentry/skills/agentry/SKILL.md",
    );
    expect(PUBLIC_INSTALL_GUIDE_URL).toBe(
      "https://github.com/agentry-sh/agentry/blob/main/INSTALL.md",
    );
    expect(PUBLIC_PRIVACY_URL).toBe(
      "https://github.com/agentry-sh/agentry/blob/main/PRIVACY.md",
    );
    expect(PUBLIC_TERMS_URL).toBe(
      "https://github.com/agentry-sh/agentry/blob/main/TERMS.md",
    );
    expect(PUBLIC_PRICING_URL).toBe(
      "https://github.com/agentry-sh/agentry/blob/main/PRICING.md",
    );
  });

  it("keeps interactive flows on the retained auth subdomain", () => {
    expect(AUTH_ORIGIN).toBe("https://auth.agentry.sh");
    expect(AUTH_BILLING_SUCCESS_URL).toBe(
      "https://auth.agentry.sh/billing/success?session_id={CHECKOUT_SESSION_ID}",
    );
  });

  it("links onboarding states to headings in the repository install guide", () => {
    expect(PUBLIC_INSTALL_REVIEW_ANCHOR).toBe(
      `${PUBLIC_INSTALL_GUIDE_URL}#4-review-and-approve-the-exact-plan`,
    );
    expect(PUBLIC_INSTALL_PROOF_ANCHOR).toBe(
      `${PUBLIC_INSTALL_GUIDE_URL}#5-apply-approved-telemetry-changes-directly-to-posthog`,
    );
    expect(PUBLIC_INSTALL_VERIFY_ANCHOR).toBe(
      `${PUBLIC_INSTALL_GUIDE_URL}#6-prove-the-deployed-result`,
    );
  });
});
