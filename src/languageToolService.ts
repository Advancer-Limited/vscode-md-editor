import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { LanguageToolConfig, LanguageToolResponse, LanguageToolMatch } from './types.js';

export class LanguageToolService {
  private config: LanguageToolConfig;

  constructor() {
    this.config = this.loadConfig();
  }

  public refreshConfig(): void {
    this.config = this.loadConfig();
  }

  private loadConfig(): LanguageToolConfig {
    const cfg = vscode.workspace.getConfiguration('vscodeMdEditor.languageTool');
    return {
      enabled: cfg.get<boolean>('enabled', true),
      apiUrl: cfg.get<string>('apiUrl', 'https://api.languagetoolplus.com/v2/check'),
      apiKey: cfg.get<string>('apiKey', ''),
      username: cfg.get<string>('username', ''),
      language: cfg.get<string>('language', 'auto'),
      motherTongue: cfg.get<string>('motherTongue', ''),
      checkDelayMs: cfg.get<number>('checkDelayMs', 1500),
    };
  }

  public isEnabled(): boolean {
    return this.config.enabled;
  }

  public getCheckDelay(): number {
    return this.config.checkDelayMs;
  }

  /** Maximum characters per API request (free tier limit). */
  private static readonly MAX_CHUNK_SIZE = 1400;

  /**
   * Send text to the LanguageTool API for checking.
   * Automatically chunks text to stay within the free API's character limit.
   */
  public async check(text: string): Promise<LanguageToolMatch[]> {
    if (!this.config.enabled || text.trim().length === 0) {
      return [];
    }

    const chunks = this.splitIntoChunks(text, LanguageToolService.MAX_CHUNK_SIZE);

    const allMatches: LanguageToolMatch[] = [];
    let offsetAdjustment = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      try {
        const matches = await this.checkChunk(chunk);
        // Adjust match offsets to account for chunk position in original text
        for (const match of matches) {
          match.offset += offsetAdjustment;
          match.context.offset += offsetAdjustment;
        }
        allMatches.push(...matches);
      } catch (error: unknown) {
        console.error(`[Grammar] Chunk ${i + 1} failed:`, error);
        this.handleCheckError(error);
        // Continue with remaining chunks even if one fails
      }

      offsetAdjustment += chunk.length;
    }

    return allMatches;
  }

  /**
   * Check a single chunk of text against the LanguageTool API.
   */
  private async checkChunk(text: string): Promise<LanguageToolMatch[]> {
    const params = new URLSearchParams();
    params.append('text', text);
    params.append('language', this.config.language);

    if (this.config.motherTongue) {
      params.append('motherTongue', this.config.motherTongue);
    }
    if (this.config.apiKey && this.config.username) {
      params.append('apiKey', this.config.apiKey);
      params.append('username', this.config.username);
    }

    const responseText = await this.postRequest(this.config.apiUrl, params.toString());
    const data = JSON.parse(responseText) as LanguageToolResponse;
    return data.matches;
  }

  /**
   * Split text into chunks on paragraph boundaries, staying under maxSize.
   */
  private splitIntoChunks(text: string, maxSize: number): string[] {
    if (text.length <= maxSize) {
      return [text];
    }

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxSize) {
        chunks.push(remaining);
        break;
      }

      // Find the last paragraph break within the limit
      let splitIdx = remaining.lastIndexOf('\n\n', maxSize);
      if (splitIdx <= 0) {
        // No paragraph break — try a single newline
        splitIdx = remaining.lastIndexOf('\n', maxSize);
      }
      if (splitIdx <= 0) {
        // No newline — try a sentence boundary (. ! ?)
        splitIdx = Math.max(
          remaining.lastIndexOf('. ', maxSize),
          remaining.lastIndexOf('! ', maxSize),
          remaining.lastIndexOf('? ', maxSize),
        );
        if (splitIdx > 0) {
          splitIdx += 2; // include the punctuation and space
        }
      }
      if (splitIdx <= 0) {
        // Last resort: hard split at maxSize
        splitIdx = maxSize;
      }

      chunks.push(remaining.slice(0, splitIdx));
      remaining = remaining.slice(splitIdx);
    }

    return chunks;
  }

  private handleCheckError(error: unknown): void {
    if (error instanceof Error) {
      if (error.message.includes('429') || error.message.includes('Too Many')) {
        vscode.window.showWarningMessage('LanguageTool: Rate limit reached. Try again in a moment.');
        return;
      }
      if (error.message.includes('ECONNREFUSED') || error.message.includes('ENOTFOUND')) {
        vscode.window.showWarningMessage(
          `LanguageTool: Could not reach API at ${this.config.apiUrl}. Check your network or API URL in settings.`
        );
        return;
      }
      vscode.window.showWarningMessage(
        `LanguageTool check failed: ${error.message}`
      );
    } else {
      vscode.window.showWarningMessage(
        `LanguageTool check failed with unexpected error: ${String(error)}`
      );
    }
  }

  /**
   * Make an HTTPS POST request using Node.js http/https modules.
   * Forces IPv4 and respects VS Code's proxy settings.
   */
  private postRequest(url: string, body: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const transport = parsedUrl.protocol === 'https:' ? https : http;

      // Check VS Code proxy settings
      const proxyUrl = vscode.workspace.getConfiguration('http').get<string>('proxy')
        || process.env.HTTPS_PROXY
        || process.env.HTTP_PROXY;

      if (proxyUrl) {
        this.postViaProxy(proxyUrl, parsedUrl, body).then(resolve, reject);
        return;
      }

      const options: https.RequestOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        family: 4, // Force IPv4
        timeout: 15000,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = transport.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const responseText = Buffer.concat(chunks).toString('utf-8');
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`LanguageTool API error ${res.statusCode}: ${responseText}`));
          } else {
            resolve(responseText);
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Connection timed out after 15s'));
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.write(body);
      req.end();
    });
  }

  /**
   * POST through an HTTP proxy using CONNECT tunneling.
   */
  private postViaProxy(proxyUrl: string, targetUrl: URL, body: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proxy = new URL(proxyUrl);

      const connectReq = http.request({
        hostname: proxy.hostname,
        port: proxy.port || 8080,
        method: 'CONNECT',
        path: `${targetUrl.hostname}:${targetUrl.port || 443}`,
        family: 4,
        timeout: 15000,
      });

      connectReq.on('connect', (_res, socket) => {
        const options: https.RequestOptions = {
          hostname: targetUrl.hostname,
          path: targetUrl.pathname + targetUrl.search,
          method: 'POST',
          createConnection: () => socket as any,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'Host': targetUrl.hostname,
          },
        };

        const req = https.request(options, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const responseText = Buffer.concat(chunks).toString('utf-8');
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`LanguageTool API error ${res.statusCode}: ${responseText}`));
            } else {
              resolve(responseText);
            }
          });
        });

        req.on('error', reject);
        req.write(body);
        req.end();
      });

      connectReq.on('timeout', () => {
        connectReq.destroy();
        reject(new Error('Proxy connection timed out'));
      });

      connectReq.on('error', reject);
      connectReq.end();
    });
  }
}
