#import "menu-clock.h"
#include <node_api.h>
#include <vector>

static LBDMenuClock *Clock(napi_env env, napi_callback_info info, size_t *argc,
                           napi_value *argv) {
  napi_value self;
  napi_get_cb_info(env, info, argc, argv, &self, nullptr);
  void *value = nullptr;
  napi_unwrap(env, self, &value);
  return (__bridge LBDMenuClock *)value;
}
static napi_value Update(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arg;
  LBDMenuClock *clock = Clock(env, info, &argc, &arg);
  size_t length = 0;
  if (!NSThread.isMainThread || argc != 1 ||
      napi_get_value_string_utf8(env, arg, nullptr, 0, &length) != napi_ok ||
      length > 4 * 1024 * 1024) {
    napi_throw_type_error(
        env, nullptr, "Menu clocks require bounded JSON on the main thread.");
    return nullptr;
  }
  std::vector<char> bytes(length + 1);
  napi_get_value_string_utf8(env, arg, bytes.data(), bytes.size(), &length);
  id rows = [NSJSONSerialization
      JSONObjectWithData:[NSData dataWithBytes:bytes.data() length:length]
                 options:0
                   error:nil];
  BOOL valid = [rows isKindOfClass:NSArray.class] && [rows count] <= 10000;
  if (valid)
    for (id row in rows) {
      if (![row isKindOfClass:NSDictionary.class] ||
          ![row[@"prefix"] isKindOfClass:NSString.class] ||
          [row[@"prefix"] length] > 1024 ||
          (row[@"since"] && (![row[@"since"] isKindOfClass:NSNumber.class] ||
                             !isfinite([row[@"since"] doubleValue]))) ||
          ![row[@"path"] isKindOfClass:NSArray.class] ||
          ![row[@"path"] count] || [row[@"path"] count] > 4) {
        valid = NO;
        break;
      }
      for (id index in row[@"path"])
        if (![index isKindOfClass:NSNumber.class] || [index integerValue] < 0 ||
            [index integerValue] > 10000 ||
            [index doubleValue] != [index integerValue]) {
          valid = NO;
          break;
        }
      if (!valid)
        break;
    }
  if (!valid) {
    napi_throw_type_error(env, nullptr, "Invalid menu-clock rows.");
    return nullptr;
  }
  clock.rows = rows;
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}
static napi_value Dispose(napi_env env, napi_callback_info info) {
  size_t argc = 0;
  [Clock(env, info, &argc, nullptr) stop];
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}
static void Finalize(napi_env env, void *data, void *hint) {
  LBDMenuClock *clock = (__bridge_transfer LBDMenuClock *)data;
  [clock stop];
}
static napi_value Create(napi_env env, napi_callback_info info) {
  if (!NSThread.isMainThread) {
    napi_throw_error(env, nullptr,
                     "Menu clocks must be created on the main thread.");
    return nullptr;
  }
  napi_value value;
  napi_create_object(env, &value);
  LBDMenuClock *clock = [LBDMenuClock new];
  napi_wrap(env, value, (__bridge_retained void *)clock, Finalize, nullptr,
            nullptr);
  napi_property_descriptor methods[] = {
      {"update", nullptr, Update, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"dispose", nullptr, Dispose, nullptr, nullptr, nullptr, napi_default,
       nullptr},
  };
  napi_define_properties(env, value, 2, methods);
  return value;
}
static napi_value Init(napi_env env, napi_value exports) {
  napi_value create;
  napi_create_function(env, "create", NAPI_AUTO_LENGTH, Create, nullptr,
                       &create);
  napi_set_named_property(env, exports, "create", create);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
