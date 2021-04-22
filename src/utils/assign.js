/*
 * @Author: DWP
 * @Date: 2021-04-21 23:19:51
 * @LastEditors: DWP
 * @LastEditTime: 2021-04-21 23:25:45
 */
// Object.assign() is not available in IE11. And the babel compiled output for object spread
// syntax checks a bunch of Symbol stuff and is almost a kb. So this function is the smaller replacement.
// 实现Object.assign，为了兼容IE11
export function assign() {
  for (let i = arguments.length - 1; i > 0; i--) {
    for (let key in arguments[i]) {
      if (key === "__proto__") {
        continue;
      }
      arguments[i - 1][key] = arguments[i][key];
    }
  }

  return arguments[0];
}
