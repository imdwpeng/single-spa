/*
 * @Author: DWP
 * @Date: 2021-04-21 23:19:51
 * @LastEditors: DWP
 * @LastEditTime: 2021-04-22 19:24:33
 */
import { reroute } from "./navigation/reroute.js";
import { formatErrorMessage } from "./applications/app-errors.js";
import { setUrlRerouteOnly } from "./navigation/navigation-events.js";
import { isInBrowser } from "./utils/runtime-environment.js";

let started = false;

/**
 * urlRerouteOnly 是否只是通过url改变时触发reroute，默认为false的布尔值。
 * 如果设置为true，调用history.pushState()和history.replaceState()将不会触发单spa重路由，除非客户端路由被更改。
 * 在某些情况下，将此设置为true会提高性能。
 * 如执行history.pushState({}, '')，url没发生变化，但是此时single-spa会手动触发popstate事件
 */
export function start(opts) {
  // 设置started为true，表示开始初始化
  started = true;
  if (opts && opts.urlRerouteOnly) {
    setUrlRerouteOnly(opts.urlRerouteOnly);
  }
  if (isInBrowser) {
    reroute();
  }
}

export function isStarted() {
  return started;
}

if (isInBrowser) {
  setTimeout(() => {
    if (!started) {
      console.warn(
        formatErrorMessage(
          1,
          __DEV__ &&
            `singleSpa.start() has not been called, 5000ms after single-spa was loaded. Before start() is called, apps can be declared and loaded, but not bootstrapped or mounted.`
        )
      );
    }
  }, 5000);
}
