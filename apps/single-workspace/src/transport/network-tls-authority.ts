import "reflect-metadata";
import { createPrivateKey, randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecureContext, type SecureContext } from "node:tls";
import {
  BasicConstraintsExtension,
  ExtendedKeyUsage,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  SubjectAlternativeNameExtension,
  X509CertificateGenerator,
} from "@peculiar/x509";
import { authorizeEgressUrl } from "./network-egress.js";

export interface NetworkTlsAuthority {
  /** Public certificate only. Never install it in the host trust store. */
  readonly certificatePath: string;
  readonly certificate: string;
  readonly contextFor: (hostname: string) => Promise<SecureContext>;
  readonly close: () => Promise<void>;
}

/** Compatibility authority for the frozen broker contract, not qualification
 * or a decision to require TLS interception in the future product contract.
 * Signing uses WebCrypto and a maintained X.509 library. Private keys remain
 * in memory; only the public certificate is mounted into the sandbox. */
export const createNetworkTlsAuthority =
  async (): Promise<NetworkTlsAuthority> => {
    const directory = await mkdtemp(join(tmpdir(), "arbor-network-ca-"));
    const certificatePath = join(directory, "authority.pem");
    const contexts = new Map<string, Promise<SecureContext>>();
    let closing = false;
    let pending = 0;
    let closePromise: Promise<void> | undefined;
    const generateKeys = () =>
      globalThis.crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"],
      );
    const validity = {
      notBefore: new Date(Date.now() - 60_000),
      notAfter: new Date(Date.now() + 24 * 60 * 60_000),
      signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    };
    try {
      await chmod(directory, 0o700);
      const keys = await generateKeys();
      const issuer = "CN=Arbor isolated network authority";
      const ca = await X509CertificateGenerator.createSelfSigned(
        {
          ...validity,
          name: issuer,
          keys,
          serialNumber: randomBytes(16).toString("hex"),
          extensions: [
            new BasicConstraintsExtension(true, 0, true),
            new KeyUsagesExtension(
              KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign,
              true,
            ),
          ],
        },
        globalThis.crypto,
      );
      const certificate = ca.toString("pem");
      await writeFile(certificatePath, certificate, {
        mode: 0o600,
        flag: "wx",
      });
      return {
        certificatePath,
        certificate,
        async contextFor(hostname) {
          if (
            closing ||
            authorizeEgressUrl(
              { version: 1, mode: "Enabled", destinations: [] },
              `https://${hostname}/`,
            ) === null
          )
            throw new Error("sandbox/tls-authority-denied");
          const existing = contexts.get(hostname);
          if (existing !== undefined) return existing;
          if (contexts.size >= 64 || pending >= 2)
            throw new Error("sandbox/tls-authority-limit");
          pending++;
          const context = (async () => {
            const leafKeys = await generateKeys();
            const leaf = await X509CertificateGenerator.create(
              {
                ...validity,
                subject: "CN=Arbor isolated network endpoint",
                issuer,
                publicKey: leafKeys.publicKey,
                signingKey: keys.privateKey,
                serialNumber: randomBytes(16).toString("hex"),
                extensions: [
                  new BasicConstraintsExtension(false, undefined, true),
                  new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
                  new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth]),
                  new SubjectAlternativeNameExtension([
                    { type: "dns", value: hostname },
                  ]),
                ],
              },
              globalThis.crypto,
            );
            return createSecureContext({
              key: createPrivateKey({
                key: Buffer.from(
                  await globalThis.crypto.subtle.exportKey(
                    "pkcs8",
                    leafKeys.privateKey,
                  ),
                ),
                format: "der",
                type: "pkcs8",
              }).export({ format: "pem", type: "pkcs8" }),
              cert: leaf.toString("pem"),
              minVersion: "TLSv1.2",
            });
          })().finally(() => {
            pending--;
          });
          contexts.set(hostname, context);
          try {
            return await context;
          } catch (error) {
            contexts.delete(hostname);
            throw error;
          }
        },
        close() {
          closing = true;
          closePromise ??= (async () => {
            await Promise.allSettled(contexts.values());
            contexts.clear();
            await rm(directory, { recursive: true, force: true });
          })();
          return closePromise;
        },
      };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  };
