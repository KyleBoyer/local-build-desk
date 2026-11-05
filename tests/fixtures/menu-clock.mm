#import "../../native/menu-clock.h"

int main() {
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    LBDMenuClock *clock = [LBDMenuClock new];
    NSMenu *menu = [NSMenu new];
    menu.autoenablesItems = NO;
    [menu addItemWithTitle:@"Local Build Desk · Native clock fixture"
                    action:nil
             keyEquivalent:@""];
    NSMenuItem *build = [menu addItemWithTitle:@"Fixture · Compile · 0s"
                                        action:nil
                                 keyEquivalent:@""];
    NSMenu *details = [NSMenu new];
    details.autoenablesItems = NO;
    [details addItemWithTitle:@"Compile · 0s" action:nil keyEquivalent:@""];
    [details addItemWithTitle:@"Elapsed: 0s" action:nil keyEquivalent:@""];
    [details addItemWithTitle:@"Waiting: 0s" action:nil keyEquivalent:@""];
    build.submenu = details;
    NSTimeInterval start = NSDate.date.timeIntervalSince1970 * 1000;
    NSArray * (^rows)(NSString *) = ^NSArray *(NSString *stage) {
      return @[
        @{
          @"path" : @[ @1 ],
          @"prefix" : [@"Fixture · " stringByAppendingString:stage],
          @"since" : @(start)
        },
        @{@"path" : @[ @1, @0 ],
          @"prefix" : stage,
          @"since" : @(start)},
        @{
          @"path" : @[ @1, @1 ],
          @"prefix" : @"Elapsed: ",
          @"since" : @(start - 3601000)
        },
        @{
          @"path" : @[ @1, @2 ],
          @"prefix" : @"Waiting: ",
          @"since" : @(start + 100000)
        },
        @{
          @"path" : @[ @9999 ],
          @"prefix" : @"Invalid index is ignored: ",
          @"since" : @(start)
        },
      ];
    };
    clock.rows = rows(@"Compile · ");
    NSMutableSet *titles = [NSMutableSet new], *elapsed = [NSMutableSet new];
    __block BOOL tracked = NO, updated = NO;
    NSTimer *driver = [NSTimer
        timerWithTimeInterval:0.1
                      repeats:YES
                        block:^(NSTimer *timer) {
                          tracked |= clock.tracking;
                          [titles addObject:build.title];
                          [elapsed addObject:[details itemAtIndex:1].title];
                          NSTimeInterval seconds =
                              (NSDate.date.timeIntervalSince1970 * 1000 -
                               start) /
                              1000;
                          if (seconds > 1.4 && !updated) {
                            clock.rows = rows(@"Upload · 25% · ");
                            updated = YES;
                          }
                          if (seconds > 3.3)
                            [menu cancelTracking];
                        }];
    [NSRunLoop.mainRunLoop addTimer:driver forMode:NSRunLoopCommonModes];
    [NSRunLoop.mainRunLoop addTimer:driver forMode:NSEventTrackingRunLoopMode];
    [menu popUpMenuPositioningItem:nil
                        atLocation:NSMakePoint(150, 150)
                            inView:nil];
    [driver invalidate];
    BOOL stopped = !clock.tracking;
    NSDictionary *result = @{
      @"tracked" : @(tracked),
      @"stopped" : @(stopped),
      @"titles" : titles.allObjects,
      @"elapsed" : elapsed.allObjects,
      @"progress" : details.itemArray[0].title,
      @"waiting" : details.itemArray[2].title,
      @"sameItem" : @([menu itemAtIndex:1] == build),
      @"sameSubmenu" : @(build.submenu == details)
    };
    [clock stop];
    NSData *data = [NSJSONSerialization dataWithJSONObject:result
                                                   options:0
                                                     error:nil];
    puts([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]
             .UTF8String);
  }
}
