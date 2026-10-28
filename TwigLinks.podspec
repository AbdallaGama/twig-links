Pod::Spec.new do |s|
  s.name             = 'TwigLinks'
  s.version          = '0.1.0'
  s.summary          = 'Twig: self-hosted Universal Links and deferred deep linking for iOS.'
  s.description      = 'Native iOS SDK for Twig, a free self-hosted deep linking, deferred deep linking and attribution server.'
  s.homepage         = 'https://github.com/your-org/twig'
  s.license          = { :type => 'MIT', :file => 'LICENSE' }
  s.author           = { 'Twig' => 'dev@example.com' }
  s.source           = { :git => 'https://github.com/your-org/twig.git', :tag => "ios-#{s.version}" }
  s.platform         = :ios, '15.0'
  s.swift_version    = '5.9'
  s.source_files     = 'sdk/ios/TwigLinks/Sources/TwigLinks/**/*.swift'
  s.resource_bundles = { 'TwigLinks_privacy' => ['sdk/ios/TwigLinks/Sources/TwigLinks/PrivacyInfo.xcprivacy'] }
end
