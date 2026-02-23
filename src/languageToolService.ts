import * as vscode from 'vscode';
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

  /**
   * Send text to the LanguageTool API for checking.
   */
  public async check(text: string): Promise<LanguageToolMatch[]> {
    if (!this.config.enabled || text.trim().length === 0) {
      return [];
    }

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

    try {
      const response = await fetch(this.config.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
        },
        body: params.toString(),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`LanguageTool API error ${response.status}: ${errorText}`);
      }

      const data = (await response.json()) as LanguageToolResponse;
      return data.matches;
    } catch (error: unknown) {
      if (error instanceof Error) {
        if (error.message.includes('429') || error.message.includes('Too Many')) {
          console.warn('LanguageTool rate limit reached, skipping check');
          return [];
        }
        vscode.window.showWarningMessage(
          `LanguageTool check failed: ${error.message}`
        );
      }
      return [];
    }
  }
}
