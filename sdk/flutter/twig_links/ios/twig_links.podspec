#
# To learn more about a Podspec see http://guides.cocoapods.org/syntax/podspec.html.
# Run `pod lib lint twig_links.podspec` to validate before publishing.
#
Pod::Spec.new do |s|
  s.name             = 'twig_links'
  s.version          = '0.1.0'
  s.summary          = 'Twig: self-hosted Universal Links, App Links and deferred deep linking.'
  s.description      = <<-DESC
Self-hosted deep linking SDK for Flutter (iOS side).
                       DESC
  s.homepage         = 'https://github.com/AbdallaGama/twig-links'
  s.license          = { :file => '../LICENSE' }
  s.author           = { 'Twig contributors' => 'https://github.com/AbdallaGama' }
  s.source           = { :path => '.' }
  s.source_files = 'twig_links/Sources/twig_links/**/*.swift'
  s.dependency 'Flutter'
  s.platform = :ios, '15.0'

  # Flutter.framework does not contain a i386 slice.
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'i386' }
  s.swift_version = '5.0'

  s.resource_bundles = {'twig_links_privacy' => ['twig_links/Sources/twig_links/PrivacyInfo.xcprivacy']}
end
