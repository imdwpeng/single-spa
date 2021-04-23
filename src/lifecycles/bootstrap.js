/*
 * @Author: DWP
 * @Date: 2021-04-21 23:19:51
 * @LastEditors: DWP
 * @LastEditTime: 2021-04-23 14:42:27
 */
import {
  NOT_BOOTSTRAPPED,
  BOOTSTRAPPING,
  NOT_MOUNTED,
  SKIP_BECAUSE_BROKEN,
} from "../applications/app.helpers.js";
import { reasonableTime } from "../applications/timeouts.js";
import { handleAppError, transformErr } from "../applications/app-errors.js";

export function toBootstrapPromise(appOrParcel, hardFail) {
  return Promise.resolve().then(() => {
    // status为NOT_BOOTSTRAPPED的才执行
    if (appOrParcel.status !== NOT_BOOTSTRAPPED) {
      return appOrParcel;
    }

    // 修改状态
    appOrParcel.status = BOOTSTRAPPING;

    if (!appOrParcel.bootstrap) {
      // Default implementation of bootstrap
      return Promise.resolve().then(successfulBootstrap);
    }

    return reasonableTime(appOrParcel, "bootstrap")
      .then(successfulBootstrap)
      .catch((err) => {
        if (hardFail) {
          throw transformErr(err, appOrParcel, SKIP_BECAUSE_BROKEN);
        } else {
          handleAppError(err, appOrParcel, SKIP_BECAUSE_BROKEN);
          return appOrParcel;
        }
      });
  });

  function successfulBootstrap() {
    appOrParcel.status = NOT_MOUNTED;
    return appOrParcel;
  }
}
