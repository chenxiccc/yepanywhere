import styles from "./Dynamic.module.css";

export function dynamicClassName(level: string): string {
  return styles[level];
}
