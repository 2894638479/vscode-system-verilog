import * as vscode from "vscode";
import * as fs from "fs";
import { ext } from "./extension";
import path from "path";
import { Logger } from "./lib/logger";
import { spawn } from "child_process";


function runVerible(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ext.languageServer.pathToVeribleSyntax.getValue(),
      [
        "--export_json",
        "--printtree",
        filePath,
      ], {
      stdio: ["ignore", "pipe", "ignore"],
      shell: false
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve(stdout);
    });
  });
}


// using verible-verilog-syntax
async function getUsedModules(filePath: string,logger:Logger) {
  const jsonStr = await runVerible(filePath)
  const ast = JSON.parse(jsonStr);
  const treeAst = ast[Object.keys(ast)[0]].tree

  function findSubmodules(node: any, parentChain: any[] = []): Set<string> {
    let result = new Set<string>();
    const chain = [...parentChain, node];
    if (node.tag === "SymbolIdentifier" && chain.length >= 5) {
      const fourthParent = chain[chain.length - 5];
      if (fourthParent?.tag === "kInstantiationType") {
        const file = node.text;
        if(file){
          result.add(file);
        }
      }
    }

    for (const child of node.children || []) {
      if(child){
        const modules = findSubmodules(child, chain)
        for(const module of modules) {
          result.add(module);
        }
      }
    }

    return result;
  }

  return findSubmodules(treeAst)
}


async function findFileInDir(
  dir: string,
  targetName: string,
  suffixies: string[],
  logger:Logger
): Promise<string | undefined> {
  const targetLower = targetName.toLowerCase();

  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) {
      continue
    }
    const ext = path.extname(entry.name).toLowerCase();
    const base = path.basename(entry.name, ext).toLowerCase();

    if (base === targetLower && suffixies.includes(ext)) {
      return path.join(dir, entry.name);
    }
  }

  return undefined;
}



async function getFileFromModuleName(file: string,suffix:string[],logger:Logger):Promise<string | undefined>{
  const dirPath = ext.index.cacheDir
  if(!dirPath) return undefined
  const fileOrLinkPath = await findFileInDir(dirPath.fsPath,file,suffix,logger)
  if(!fileOrLinkPath) return undefined
  const stats = await fs.promises.lstat(fileOrLinkPath);

  if (stats.isSymbolicLink()) {
    const realPath = await fs.promises.readlink(fileOrLinkPath);
    return path.resolve(path.dirname(fileOrLinkPath), realPath);
  } else {
    return fileOrLinkPath;
  }
}

async function preloadModulesInFile(
  filePath: string,
  logger:Logger
) {
  const suffixs = [".svh",".sv",".v"]
  const fileUri = vscode.Uri.file(filePath);
  const ext = path.extname(fileUri.fsPath).toLowerCase();
  if(!suffixs.includes(ext)) return;

  logger.info(`preloading file ${filePath}`)
  if (!fs.existsSync(filePath)) {
    logger.warn(`unable to preload file ${filePath}`)
    return;
  }

  async function preloadModule(module:string){
    const file = await getFileFromModuleName(module,suffixs,logger);
    if(file !== undefined) {
      vscode.workspace.openTextDocument(file)
    } else {
      logger.warn(`not found file for module ${module}`)
    }
  }

  const usedModules = await getUsedModules(filePath,logger)
  for(const module of usedModules) {
    preloadModule(module)
  }
}

var listener: vscode.Disposable|undefined = undefined

export function activateAutoLoad(logger:Logger) {
  deactivateAutoLoad()
  vscode.window.visibleTextEditors.forEach((editor) => {
    preloadModulesInFile(editor.document.fileName,logger)
  })
  listener = vscode.window.onDidChangeVisibleTextEditors((editors) => {
    for(const editor of editors) {
      preloadModulesInFile(editor.document.fileName,logger)
    }
  });
}

export function deactivateAutoLoad(){
  if(listener) {
    listener.dispose()
    listener = undefined
  }
}