export async function fileFingerprint(file) {
  // Hash the complete bounded file: sampled bytes do not prove equality.
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}

export function createUploadGate(items) {
  const reserved = new Set();
  return {
    claim(kind, fingerprint) {
      const key = `${kind}:${fingerprint}`;
      if (reserved.has(key) || items().some(item => item.kind === kind && item.fingerprint === fingerprint)) return null;
      reserved.add(key);
      let released = false;
      return () => {
        if (!released) {
          released = true;
          reserved.delete(key);
        }
      };
    },
  };
}
