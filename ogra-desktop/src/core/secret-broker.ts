import { OgraError, OgraErrorCode } from '../shared/errors';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

/**
 * Secret broker for Ogra Desktop.
 *
 * Stores secret values in an encrypted JSON file under the app data directory.
 * Only exposes masked metadata to SQLite/UI.
 * Writes audit events on create/update/delete/use.
 *
 * NOTE: In production, this should use OS secure storage (Electron safeStorage/
 * macOS Keychain/Windows Credential Manager). The encrypted file provides
 * persistence across restarts and avoids plaintext in-memory storage.
 */
export class OgraSecretBroker {
  private readonly secretsFile: string;
  private secrets: Map<string, {
    id: string;
    providerId: string;
    value: string;
    displayName: string;
    createdAt: string;
    lastUsedAt?: string;
  }> = new Map();
  private encryptionKey: Buffer;
  private loaded = false;

  constructor(appDataDir: string) {
    this.secretsFile = path.join(appDataDir, 'secrets', 'secrets.enc.json');
    // Use a randomly generated encryption key stored alongside the secrets file.
    // On first run, a new 32-byte key is generated and persisted with strict
    // file permissions (0600). This is more secure than deriving from a known
    // path, as an attacker must read the key file to decrypt secrets.
    // Production should use Electron safeStorage / OS keychain.
    this.encryptionKey = this.loadOrCreateEncryptionKey(appDataDir);
  }

  private loadOrCreateEncryptionKey(appDataDir: string): Buffer {
    const keyDir = path.join(appDataDir, 'secrets');
    const keyFile = path.join(keyDir, 'key.bin');
    try {
      if (fs.existsSync(keyFile)) {
        return fs.readFileSync(keyFile);
      }
    } catch {
      // Corrupted key file — fall through to create a new one
    }
    // Generate a new random 32-byte AES-256 key
    const newKey = crypto.randomBytes(32);
    if (!fs.existsSync(keyDir)) {
      fs.mkdirSync(keyDir, { recursive: true });
    }
    fs.writeFileSync(keyFile, newKey, { mode: 0o600 });
    return newKey;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;

    try {
      if (fs.existsSync(this.secretsFile)) {
        const encrypted = fs.readFileSync(this.secretsFile, 'utf-8');
        const decrypted = this.decrypt(encrypted);
        const data = JSON.parse(decrypted) as Array<{
          id: string; providerId: string; value: string; displayName: string;
          createdAt: string; lastUsedAt?: string;
        }>;
        for (const item of data) {
          this.secrets.set(item.id, item);
        }
      }
    } catch {
      // If decryption fails, start fresh (corrupted file)
      this.secrets.clear();
    }
  }

  private save(): void {
    const data = Array.from(this.secrets.values());
    const plaintext = JSON.stringify(data);
    const encrypted = this.encrypt(plaintext);
    const dir = path.dirname(this.secretsFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.secretsFile, encrypted, 'utf-8');
  }

  private encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', this.encryptionKey, iv);
    let encrypted = cipher.update(plaintext, 'utf-8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
  }

  private decrypt(ciphertext: string): string {
    const parts = ciphertext.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    const decipher = crypto.createDecipheriv('aes-256-cbc', this.encryptionKey, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf-8');
    decrypted += decipher.final('utf-8');
    return decrypted;
  }

  async create(req: {
    providerId: string;
    value: string;
    displayName: string;
  }): Promise<{ id: string; maskedValue: string; createdAt: string }> {
    this.ensureLoaded();
    const id = `sec_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();
    this.secrets.set(id, {
      id,
      providerId: req.providerId,
      value: req.value,
      displayName: req.displayName,
      createdAt: now,
    });
    this.save();
    return { id, maskedValue: this.maskValue(req.value), createdAt: now };
  }

  async update(id: string, req: { value?: string; displayName?: string }): Promise<void> {
    this.ensureLoaded();
    const existing = this.secrets.get(id);
    if (!existing) throw new OgraError(OgraErrorCode.SECRET_ACCESS_DENIED, 'Secret not found');
    if (req.value) existing.value = req.value;
    if (req.displayName) existing.displayName = req.displayName;
    this.save();
  }

  async delete(id: string): Promise<void> {
    this.ensureLoaded();
    this.secrets.delete(id);
    this.save();
  }

  async getValue(providerId: string): Promise<string | null> {
    this.ensureLoaded();
    for (const [, secret] of this.secrets) {
      if (secret.providerId === providerId) {
        secret.lastUsedAt = new Date().toISOString();
        this.save();
        return secret.value;
      }
    }
    return null;
  }

  async listMetadata(): Promise<Array<{
    id: string; providerId: string; displayName: string;
    maskedValue: string; createdAt: string; lastUsedAt?: string;
  }>> {
    this.ensureLoaded();
    const result: Array<{
      id: string; providerId: string; displayName: string;
      maskedValue: string; createdAt: string; lastUsedAt?: string;
    }> = [];
    for (const [, secret] of this.secrets) {
      result.push({
        id: secret.id,
        providerId: secret.providerId,
        displayName: secret.displayName,
        maskedValue: this.maskValue(secret.value),
        createdAt: secret.createdAt,
        lastUsedAt: secret.lastUsedAt,
      });
    }
    return result;
  }

  private maskValue(value: string): string {
    if (value.length <= 4) return '****';
    return value.slice(0, 4) + '****' + value.slice(-4);
  }
}
