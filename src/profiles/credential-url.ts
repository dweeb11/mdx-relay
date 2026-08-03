const supportedSchemePrefix = /^(https?|ssh|git):/iu;
const strictSupportedSchemeUrl = /^(?:https?|ssh|git):\/\//iu;

export const isCredentialBearingUrl = (value: string): boolean => {
  const schemeMatch = supportedSchemePrefix.exec(value);
  if (schemeMatch) {
    if (value.includes("?") || value.includes("#")) return true;
    if (strictSupportedSchemeUrl.test(value) && !value.includes("\\")) {
      try {
        const parsed = new URL(value);
        return (
          parsed.password.length > 0 ||
          (parsed.protocol !== "ssh:" && parsed.username.length > 0)
        );
      } catch {
        // Inspect malformed supported-scheme values below without SCP fallback.
      }
    }
    const authority = value
      .slice(schemeMatch[0].length)
      .replace(/^[/\\]+/u, "")
      .split(/[/\\]/u, 1)[0]!;
    const atIndex = authority.lastIndexOf("@");
    if (atIndex <= 0) return false;
    const userInfo = authority.slice(0, atIndex);
    return schemeMatch[1]!.toLowerCase() !== "ssh" || userInfo.includes(":");
  }

  if (/^[a-z]:[\\/]/iu.test(value)) return false;
  if (value.includes("\\")) return false;
  if (/^[^/@:\s]+:[^@/\s]+@[^/@:\s]+\//u.test(value)) return true;
  if (/^[^/@:\s]+:[^@/\s]+@[^/@:\s]+:[^\\?#\s]+$/u.test(value)) return true;
  if (/^(?:[^/@:\s]+@)?[^/@:\s]+:[^\\?#\s]+[?#].*$/u.test(value)) return true;
  return false;
};
