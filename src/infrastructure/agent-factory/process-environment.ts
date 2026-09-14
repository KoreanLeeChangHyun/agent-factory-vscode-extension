import { homedir } from "node:os";
import { join } from "node:path";

/** GUI hosts may omit package-manager paths; preserve the caller's search order. */
export function runtimeEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory = homedir()
): NodeJS.ProcessEnv {
  if (platform !== "darwin") return { ...environment };
  const paths = environment.PATH === undefined ? ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] : environment.PATH.split(":");
  for (const directory of ["/opt/homebrew/bin", "/usr/local/bin", join(homeDirectory, ".local", "bin")]) {
    if (!paths.includes(directory)) paths.push(directory);
  }
  return { ...environment, PATH: paths.join(":") };
}
