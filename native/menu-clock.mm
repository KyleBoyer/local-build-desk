#import "menu-clock.h"

@implementation LBDMenuClock {
  __weak NSMenu *_menu;
  NSTimer *_timer;
}
- (instancetype)init {
  if ((self = [super init])) {
    _rows = @[];
    NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
    [center addObserver:self
               selector:@selector(begin:)
                   name:NSMenuDidBeginTrackingNotification
                 object:nil];
    [center addObserver:self
               selector:@selector(end:)
                   name:NSMenuDidEndTrackingNotification
                 object:nil];
  }
  return self;
}
- (BOOL)tracking {
  return _timer != nil;
}
- (void)begin:(NSNotification *)notice {
  NSMenu *menu =
      [notice.object isKindOfClass:NSMenu.class] ? notice.object : nil;
  if (!menu ||
      ![menu.itemArray.firstObject.title hasPrefix:@"Local Build Desk · "] ||
      !_rows.count)
    return;
  [_timer invalidate];
  _menu = menu;
  [self tick];
  if (![_rows indexesOfObjectsPassingTest:^BOOL(NSDictionary *row,
                                                NSUInteger index, BOOL *stop) {
         return row[@"since"] != nil;
       }].count) {
    _menu = nil;
    return;
  }
  // Node timers/model mutations alone do not repaint Electron's open NSMenu.
  // Explicit tracking mode also covers AppKit's nested submenu event loop.
  __weak LBDMenuClock *weakSelf = self;
  _timer = [NSTimer timerWithTimeInterval:0.25
                                  repeats:YES
                                    block:^(NSTimer *timer) {
                                      [weakSelf tick];
                                    }];
  _timer.tolerance = 0.05;
  [NSRunLoop.mainRunLoop addTimer:_timer forMode:NSRunLoopCommonModes];
  [NSRunLoop.mainRunLoop addTimer:_timer forMode:NSEventTrackingRunLoopMode];
}
- (void)end:(NSNotification *)notice {
  if (notice.object != _menu)
    return;
  [_timer invalidate];
  _timer = nil;
  _menu = nil;
}
- (void)tick {
  NSMenu *root = _menu;
  if (!root)
    return;
  NSTimeInterval now = NSDate.date.timeIntervalSince1970 * 1000;
  for (NSDictionary *row in _rows) {
    NSMenu *menu = root;
    NSMenuItem *item = nil;
    NSArray<NSNumber *> *path = row[@"path"];
    for (NSUInteger i = 0; i < path.count; i++) {
      NSInteger index = path[i].integerValue;
      if (!menu || index < 0 || index >= menu.numberOfItems) {
        item = nil;
        break;
      }
      item = [menu itemAtIndex:index];
      if (i + 1 < path.count)
        menu = item.submenu;
    }
    if (!item)
      continue;
    if (!row[@"since"]) {
      if (![item.title isEqualToString:row[@"prefix"]])
        item.title = row[@"prefix"];
      continue;
    }
    long long seconds =
        MAX(0LL, (long long)floor((now - [row[@"since"] doubleValue]) / 1000));
    NSString *time =
        seconds >= 3600
            ? [NSString stringWithFormat:@"%lldh %lldm %02llds", seconds / 3600,
                                         (seconds % 3600) / 60, seconds % 60]
        : seconds >= 60 ? [NSString stringWithFormat:@"%lldm %02llds",
                                                     seconds / 60, seconds % 60]
                        : [NSString stringWithFormat:@"%llds", seconds];
    NSString *title = [row[@"prefix"] stringByAppendingString:time];
    if (![item.title isEqualToString:title])
      item.title = title;
  }
}
- (void)stop {
  [NSNotificationCenter.defaultCenter removeObserver:self];
  [_timer invalidate];
  _timer = nil;
  _menu = nil;
  _rows = @[];
}
- (void)dealloc {
  [self stop];
}
@end
