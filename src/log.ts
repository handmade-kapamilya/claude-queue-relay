import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export class Log implements vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel('Claude Queue Relay');

  constructor(private readonly file: string, private readonly windowName: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  info(msg: string): void {
    this.write('INFO', msg);
  }

  warn(msg: string): void {
    this.write('WARN', msg);
  }

  show(): void {
    this.channel.show();
  }

  dispose(): void {
    this.channel.dispose();
  }

  private write(level: string, msg: string): void {
    const line = `${new Date().toISOString()} ${level} [${this.windowName}] ${msg}`;
    this.channel.appendLine(line);
    try {
      if (fs.existsSync(this.file) && fs.statSync(this.file).size > 1_000_000) {
        fs.renameSync(this.file, `${this.file}.1`);
      }
      fs.appendFileSync(this.file, `${line}\n`);
    } catch {
      // logging must never throw
    }
  }
}
