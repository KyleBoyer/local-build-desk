#import <Cocoa/Cocoa.h>

// Only clocks on this app's tray are changed; menu ownership and actions stay
// with Electron. No callbacks into JavaScript occur during native tracking.
@interface LBDMenuClock : NSObject
@property(nonatomic, copy) NSArray<NSDictionary *> *rows;
@property(nonatomic, readonly) BOOL tracking;
- (void)stop;
@end
